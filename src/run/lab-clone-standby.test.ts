import { expect, test } from 'bun:test';
import { fixtureCR, snapshot } from '../telemetry/fixtures';
import { RealLab, type LabDeps } from './lab';
import { SshEnv } from './ssh-env';

const host = { ip: 'vm', seed: 1, name: 'vm' };
test('SSH opt-in requests both nodes and parses their separate ports', async () => {
  let cmd = '';
  const env = new SshEnv(host, async (_ip, c) => {
    cmd = c;
    return { stdout: 'clone 1 started port=5501 standby_port=5601 2.04', stderr: '', exitCode: 0 };
  });
  expect(await env.createClone('c', { withStandby: true })).toEqual({ kind: 'clone', port: 5501, standbyPort: 5601, name: 'c', n: 1 });
  expect(cmd).toBe('/opt/pgaibench/env/clone.sh start 1 --with-standby');
});
test.each(['port=5501', 'standby_port=5601'])('SSH rejects an incomplete pair %s when a standby is requested', async output => {
  const env = new SshEnv(host, async () => ({ stdout: output, stderr: '', exitCode: 0 }));
  await expect(env.createClone('c', { withStandby: true })).rejects.toThrow('port');
});

test.each([false, true])('rehearsal tunnels and samples both instances with clonePostWindow=%p', async post => {
  const calls: string[] = [], ports: number[][] = [];
  const deps: LabDeps = {
    tunnel: async (_ip, remote) => {
      ports.push(remote);
      return { ports: { 5502: 35502, 5602: 35602 }, close: async () => { calls.push('closed'); } };
    },
    collect: async (conn, opts) => {
      calls.push('collect ' + conn.port + ' ' + opts?.standbyConn?.port);
      expect(opts?.backupVerify).toBe(false);
      return snapshot();
    },
    run: async (_ip, cmd) => {
      calls.push(cmd);
      const summary = { tps: 100, overall: { count: 20, p50_ms: 3, p99_ms: 4 }, shapes: { q07: { count: 10, p50_ms: 3, p99_ms: 4 } } };
      return { stdout: JSON.stringify(summary), stderr: '', exitCode: 0 };
    },
    applyCR: async (_cr, t, opts) => {
      calls.push('actor ' + t.conn.port + ' ' + opts?.telemetry?.standbyConn?.port);
      return { steps: [], aborted: false, rolledBack: false, rollbackErrors: [], logPath: 'a' };
    },
    client: () => { throw new Error('unexpected connection'); }, sleep: async () => {},
  };
  const lab = new RealLab(host, deps);
  const cr = fixtureCR();
  cr.task = 'D21';
  cr.rehearsal.thresholds = { 'shape_post_p50_ms:q07': '<0.5x' };
  const r = await lab.rehearse(cr, { kind: 'clone', n: 2, name: 'c', port: 5502, standbyPort: 5602 }, snapshot(), 2, 'a', { clonePostWindow: post });
  expect(ports).toEqual([[5502, 5602]]);
  expect(calls).toContain('actor 35502 35602');
  expect(calls.filter(c => c.startsWith('collect '))).toEqual(Array(post ? 5 : 3).fill('collect 35502 35602'));
  expect(calls.filter(c => c.includes('w_prod.sh 2 W_prod 5502 5602'))).toHaveLength(1);
  expect(calls.filter(c => c.includes('w_prod.sh 60 W_prod 5502 5602'))).toHaveLength(post ? 1 : 0);
  expect(calls.at(-1)).toBe('closed');
  expect(r.notes.join(' ')).toContain('separate streaming hot standby on port 5602');
  if (post) {
    expect(r.after.metrics['shape_post_p50_ms:q07']).toBe(3);
    expect(r.diff.thresholds[0]).toMatchObject({ actual: 3, baseline: 9, pass: true });
    expect(r.diff.thresholds[0]?.not_judged).toBeUndefined();
  }
});
