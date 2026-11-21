import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyCR, VM_NOW } from './actor';
import { fixtureCR, snapshot } from '../telemetry/fixtures';
import type { ActorOptions, ActorTarget, CR } from '../schema/types';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'actor-clone-')); });
afterEach(() => rm(dir, { recursive: true, force: true }));

const primary = { host: 'localhost', port: 35502, user: 'postgres', password: '', database: 'app' };
const standby = { ...primary, port: 35602 };
const target: ActorTarget = { conn: primary, ip: 'vm', kind: 'clone', clone: 2 };
const setting = 'max_locks_per_transaction';
async function run(steps: CR['steps']) {
  const commands: string[] = [], writes: string[] = [], collectPorts: (number | undefined)[] = [];
  const values = new Map([[primary.port, '64'], [standby.port, '64']]);
  const cr = fixtureCR();
  cr.steps = steps;
  const options: ActorOptions = {
    logPath: join(dir, 'actor.jsonl'), telemetry: { standbyConn: standby },
    clientFactory: conn => ({ unsafe: async q => {
      if (q.startsWith('select context')) return [{ context: 'postmaster', setting: values.get(conn.port), source: 'default' }];
      if (q.startsWith('select setting')) return [{ setting: values.get(conn.port), pending_restart: false }];
      if (q.startsWith('alter system')) {
        writes.push(conn.port + ' ' + q);
        values.set(conn.port, /E'(\d+)'/.exec(q)?.[1] ?? '64');
      }
      if (q === 'select crash()') throw Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' });
      return [];
    }, end: async () => {} }),
    collect: async (_conn, opts) => { collectPorts.push(opts?.standbyConn?.port); return snapshot(); },
    runOnHost: async (_ip, cmd) => {
      commands.push(cmd);
      let stdout = 'downtime_s=1 start_s=2 end_s=3';
      if (cmd === VM_NOW) stdout = '2026-11-09T10:00:00.250000000Z';
      if (cmd.includes('docker logs')) stdout = cmd.includes('pgaibench-clone-2-standby') ? '2026-11-09 10:00:00.500 UTC [42] FATAL:  invalid value for parameter "shared_buffers": "bad"' : '';
      if (cmd.includes('OOMKilled')) stdout = 'oom_killed=false';
      return { stdout, stderr: '', exitCode: 0 };
    },
  };
  return { result: await applyCR(cr, target, options), commands, writes, collectPorts, values };
}

test('standby-only config restarts and reads back on the clone standby, including step snapshots', async () => {
  const h = await run([{ config: { name: setting, value: '128' }, node: 'standby', expect: { ['setting:' + setting]: '==128' } }]);
  expect(h.result.steps[0]).toMatchObject({ ok: true, setting_standby: '128' });
  expect(h.result.steps[0]?.setting_primary).toBeUndefined();
  expect(h.collectPorts).toEqual([standby.port, standby.port]);
  expect(h.commands.filter(c => c.includes('restart.sh'))).toEqual(['/opt/pgaibench/env/restart.sh clone-standby 2']);
  expect(h.values.get(primary.port)).toBe('64');
  expect(h.result.standby_downtime_s).toBe(1);
});

test.each(['128', '32'])('both-node change to %s restarts in recovery-safe order and restores in reverse', async value => {
  const h = await run([{ config: { name: setting, value }, node: 'both', expect: { p99_ms: '<1' } }]);
  expect(h.result.steps[0]?.error).toContain('Expectation breached');
  expect(h.result.rolledBack).toBe(true);
  expect(h.result.rollbackErrors).toEqual([]);
  const nodes = value === '128' ? ['standby', 'primary'] : ['primary', 'standby'];
  const order = [...nodes, ...[...nodes].reverse()];
  expect(h.result.restarts?.map(r => [r.node, r.rollback])).toEqual(order.map((n, i) => [n, i >= 2]));
  expect(h.commands.filter(c => c.includes('restart.sh'))).toEqual(order.map(n => '/opt/pgaibench/env/restart.sh ' + (n === 'primary' ? 'clone' : 'clone-standby') + ' 2'));
  expect(h.writes.map(s => Number(s.split(' ')[0]))).toEqual(order.map(n => n === 'primary' ? primary.port : standby.port));
  expect([...h.values.values()]).toEqual(['64', '64']);
});

test('server error reads both clone logs and OOM flags', async () => {
  const h = await run([{ sql: 'select crash()', expect: {} }]);
  expect(h.result.steps[0]?.error_class).toBe('server');
  expect(h.result.steps[0]?.server_log?.[0]).toStartWith('pgaibench-clone-2-standby:');
  expect(h.result.steps[0]?.oom_killed).toEqual({ 'pgaibench-clone-2': false, 'pgaibench-clone-2-standby': false });
});
