import postgres from 'postgres';
import type { ClientFactory, Row, SqlClient } from '../schema/types';

/** One database session per change request. The CR's SQL steps run on one
 *  reserved connection: no client idle timeout, max 1. postgres.js does not
 *  replace a reserved connection: when the server closes it (an idle
 *  timeout, a crash, a restart), every later query fails. The FATAL the
 *  server sent is the error, so the Actor's rules classify it. */
export const SESSION_OPTIONS = { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0, connection: { application_name: 'pgaibench-harness' } };
type Lease = { unsafe(query: string): PromiseLike<Row[]> & { cancel?: () => unknown }; release(): void };
type Reservable = { reserve(): Promise<Lease>; end(options?: { timeout?: number }): Promise<void> };
const CLOSED = new Set(['CONNECTION_CLOSED', 'CONNECTION_DESTROYED', 'CONNECTION_ENDED']);
function unwrap(error: any): unknown {
  const cause = error?.cause;
  return CLOSED.has(error?.code) && cause?.severity === 'FATAL' && typeof cause.code === 'string' ? cause : error;
}
export function sessionClient(pool: Reservable): SqlClient {
  let lease: Promise<Lease> | undefined;
  return {
    unsafe(query: string) {
      let inner: ReturnType<Lease['unsafe']> | undefined;
      const result = (lease ??= pool.reserve()).then(l => (inner = l.unsafe(query))).then(rows => rows, error => { throw unwrap(error); });
      return Object.assign(result, { cancel: () => inner?.cancel?.() });
    },
    async end(options) {
      try { (await lease)?.release(); } catch { /* never reserved */ }
      await pool.end(options);
    },
  };
}
export const createSessionClient: ClientFactory = conn => sessionClient(postgres({ ...conn, ...SESSION_OPTIONS }) as unknown as Reservable);
