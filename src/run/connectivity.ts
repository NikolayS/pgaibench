// Connectivity loss on the local ssh tunnel endpoint versus a database error.
//
// The harness reaches Postgres on the VM through `ssh -L 127.0.0.1:<local>`.
// How the two cases differ:
// - Tunnel lost (the ssh process is gone): nothing listens on the local
//   forward port, so the client's connect() itself fails on
//   127.0.0.1:<local port>: "connect ECONNREFUSED|ETIMEDOUT|ECONNRESET
//   127.0.0.1:<local>". Only a dead local forward gives that error.
// - Database down behind a live tunnel (the CR stopped or restarted
//   Postgres): ssh accepts the local connect, then closes the channel when
//   the remote connect fails. The client sees "Connection terminated",
//   "read ECONNRESET", a 57P01 or "starting up" error: the database's.
// A reset or timeout that is not a connect() to a local port is ambiguous;
// the tunnel liveness probe (the ssh process still running) decides it.

const LOCAL_CONNECT = /\bconnect (ECONNREFUSED|ECONNRESET|ETIMEDOUT) 127\.0\.0\.1:(\d+)/;
// The harness's own ssh to the VM (host commands) could not connect: the network, not the database.
const HOST_SSH = /\bssh: connect to host \S+ port 22: /;
const AMBIGUOUS = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|connection closed|socket hang up/i;

/** Errors that are a loss of the local tunnel (with `tunnelAlive` false, a
 *  first entry "tunnel: ssh process exited"). Empty: no connectivity loss. */
export function connectivityLoss(errors: readonly string[], localPorts: readonly number[], tunnelAlive?: boolean): string[] {
  const ports = new Set(localPorts);
  const local = (e: string) => { const m = LOCAL_CONNECT.exec(e); return (!!m && ports.has(Number(m[2]))) || HOST_SSH.test(e); };
  if (tunnelAlive === false) return ["tunnel: ssh process exited", ...errors.filter(e => local(e) || AMBIGUOUS.test(e))];
  return errors.filter(local);
}
