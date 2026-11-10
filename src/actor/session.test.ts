import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCR } from './actor';
import { SESSION_OPTIONS, sessionClient } from './session';
import { fixtureCR, snapshot } from '../telemetry/fixtures';

// A fake postgres.js pool with its lease semantics: a reserved connection
// that the server closed rejects every later query with CONNECTION_CLOSED,
// cause = the FATAL the server sent while the connection was idle.
function fakePool() {
  const state = { reserves: 0, released: 0, ended: 0, closed: null as any, ran: [] as string[], pids: [] as number[] };
  let pid = 100;
  const pool = {
    reserve: async () => {
      state.reserves++; const mine = ++pid;
      return {
        unsafe: (q: string) => {
          state.ran.push(q); state.pids.push(mine);
          if (state.closed) return Promise.reject(Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED', cause: state.closed }));
          return Promise.resolve([]);
        },
        release: () => { state.released++; },
      };
    },
    end: async () => { state.ended++; },
  };
  const idleKill = () => { state.closed = Object.assign(new Error('terminating connection due to idle-session timeout'), { code: '57P05', severity: 'FATAL' }); };
  return { pool, state, idleKill };
}

test('session options: one connection, no client idle timeout', () => {
  expect(SESSION_OPTIONS.max).toBe(1);
  expect(SESSION_OPTIONS.idle_timeout).toBe(0);
});

test('all queries of a session run on one reserved connection', async () => {
  const { pool, state } = fakePool(), c = sessionClient(pool);
  await c.unsafe("set lock_timeout = '1s'"); await c.unsafe('select 1'); await c.end();
  expect(state.reserves).toBe(1);
  expect(new Set(state.pids).size).toBe(1);
  expect(state.released).toBe(1); expect(state.ended).toBe(1);
});

test('a connection the server closed while idle is not replaced: the query gets the FATAL', async () => {
  const { pool, state, idleKill } = fakePool(), c = sessionClient(pool);
  await c.unsafe('select 1'); idleKill();
  const error: any = await Promise.resolve(c.unsafe('select 2')).catch(e => e);
  expect(error.code).toBe('57P05'); expect(error.severity).toBe('FATAL');
  expect(state.reserves).toBe(1);
});

test('57P05 own-session-loss rule fires at the connection level: idle timeout set by the CR, killed between steps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-session-'));
  const { pool, state, idleKill } = fakePool();
  const cr = fixtureCR();
  cr.steps = [{ sql: "set idle_session_timeout = '1s'", expect: {} }, { sql: 'select 2', expect: {} }]; cr.rollback = ['select 0'];
  let collects = 0;
  const result = await applyCR(cr, { kind: 'production', ip: '192.0.2.11', conn: { host: 'h', port: 1, user: 'u', password: 'p', database: 'd' } } as any, {
    baseline: snapshot(), logPath: join(dir, 'a.jsonl'),
    clientFactory: () => sessionClient(pool),
    // The step snapshot is the idle gap: the server kills the session then.
    collect: async () => { if (++collects === 1) idleKill(); return snapshot(); },
    runOnHost: async (_ip, cmd) => ({ stdout: cmd.startsWith('date ') ? '2026-11-09T10:00:00.250000000Z' : '', stderr: '', exitCode: 0 }),
  });
  expect(result.steps[0]!.ok).toBe(true);
  expect(result.steps[1]!.ok).toBe(false);
  expect(result.steps[1]!.error_class).toBe('cr');
  // Both CR steps used the one reserved connection.
  expect(state.pids.slice(0, 2)).toEqual([state.pids[0]!, state.pids[0]!]);
});

test('the Actor uses the session client by default; telemetry keeps its own client', async () => {
  const actor = await import('./actor'), { createSessionClient } = await import('./session'), { createClient } = await import('../telemetry/collect');
  expect(actor.ACTOR_CLIENT).toBe(createSessionClient);
  expect(actor.ACTOR_CLIENT).not.toBe(createClient);
});
