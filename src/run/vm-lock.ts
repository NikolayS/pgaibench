// One batch process per lab VM. The batch holds a kernel lock (flock) on the
// VM through one ssh session for its whole life. When the batch process ends
// in any way, its ssh session ends, the remote `cat` sees end of input and
// the kernel drops the lock. Nothing is written that could go stale; the path
// is on /run (tmpfs), so a VM reboot clears it too.
import { sshOptions } from "../actor/host";

export const VM_LOCK_PATH = "/run/pgaibench-batch.lock";
/** Exit code of flock when another process holds the lock. */
export const LOCK_BUSY_EXIT = 75;

export class VmBusyError extends Error {
  constructor(ip: string) { super(`another batch process holds the lab VM lock on ${ip} (${VM_LOCK_PATH}); refusing to start`); this.name = "VmBusyError"; }
}

export interface LockProc { lines(): AsyncIterable<string>; exited: Promise<number>; kill(): void }
export interface VmLock { proc: LockProc; release(): Promise<void> }

export function vmLockArgs(ip: string): string[] {
  return ["ssh", ...sshOptions(), `root@${ip}`, `exec flock -n -E ${LOCK_BUSY_EXIT} ${VM_LOCK_PATH} sh -c 'echo LOCKED; exec cat >/dev/null'`];
}

function spawnSsh(args: string[]): LockProc {
  const p = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  return {
    async *lines() { let buf = ""; const d = new TextDecoder(); for await (const c of p.stdout) { buf += d.decode(c, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); } } },
    exited: p.exited,
    kill: () => p.kill(),
  };
}

/** Takes the VM lock or throws (VmBusyError when another batch holds it). */
export async function acquireVmLock(ip: string, o: { spawn?: (args: string[]) => LockProc } = {}): Promise<VmLock> {
  const proc = (o.spawn ?? spawnSsh)(vmLockArgs(ip));
  for await (const l of proc.lines()) {
    if (l.trim() === "LOCKED") {
      const release = async () => { proc.kill(); await proc.exited; };
      return { proc, release };
    }
  }
  const code = await proc.exited;
  if (code === LOCK_BUSY_EXIT) throw new VmBusyError(ip);
  throw new Error(`could not take the lab VM lock on ${ip}: ssh exited ${code}`);
}

/** Runs fn while this process holds the VM lock; releases it after fn ends. */
export async function withVmLock<T>(ip: string, fn: () => Promise<T>, o: { spawn?: (args: string[]) => LockProc } = {}): Promise<T> {
  const lock = await acquireVmLock(ip, o);
  try { return await fn(); } finally { await lock.release(); }
}
