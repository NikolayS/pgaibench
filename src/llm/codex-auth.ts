// N3: the Codex login a generation call uses, and the write-back of a token
// the CLI refreshed in the temporary copy.
//
// Each call gets a fresh home with a mode-600 copy of $HOME/.codex/auth.json.
// After the call, if the copy changed (the CLI refreshed the OAuth token;
// ChatGPT refresh tokens are single-use, so the old stored one may now be
// revoked) and the real file still has the hash it had when we copied it,
// the refreshed copy is written back atomically: temp file in ~/.codex,
// mode 600, fsync, rename. The write-back holds an exclusive lock file
// (auth.json.pgaibench-lock, created with O_EXCL; an existing one stops the
// write-back as a conflict and is left alone) and re-hashes the real file
// right before the rename; a change aborts as a conflict. The first
// write-back keeps the previous content as auth.json.pgaibench-bak (mode
// 600); an existing backup file is never overwritten. If the real file
// changed meanwhile (another Codex session refreshed it, or a concurrent
// call of ours did), nothing is written: the refreshed copy goes to a
// mode-700 directory under the run output, and every later Codex call of
// this process fails access:login_conflict. This write-back is the only
// change this harness ever makes under ~/.codex.
//
// Serialization: copy and write-back of all calls on one login run under
// one in-process lock, so a write-back is never interleaved with another
// call's copy or write-back. Two calls that copied the same old login and
// both refreshed cannot clobber each other: the second sees the real file
// changed and stops.

import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./cli-gen";

const sha = (b: Buffer) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const locks = new Map<string, Promise<unknown>>();
const stopped = new Map<string, string>();
const backedUp = new Set<string>();
class LoginChanged extends Error {}

function serial<T>(key: string, f: () => T | Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(f, f);
  locks.set(key, next.catch(() => {}));
  return next;
}

/** Test hook: runs right before the rename of a write-back. */
export const codexLoginHooks: { beforeRename?: () => void } = {};

/** Writes data to path through a mode-600 temp file in the same directory: write, fsync, rename.
 *  guard runs right before the rename; a throw removes the temp file and nothing is renamed. */
function atomicWrite600(path: string, data: Buffer, guard?: () => void) {
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.pgaibench-tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { chmodSync(tmp, 0o600); guard?.(); renameSync(tmp, path); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Writes data to a new mode-600 file; never replaces an existing one. */
function createOnly600(path: string, data: Buffer) {
  const fd = openSync(path, "wx", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}

export interface CodexLoginLog { written_back: number; conflicts: number }
export const codexLoginLog: CodexLoginLog = { written_back: 0, conflicts: 0 };

/** Runs f with a fresh home holding a copy of the login; handles a refresh as described above. stash: dir under the run output for a refreshed copy that cannot be written back. */
export async function withCodexLogin<T>(source: string, stash: string | undefined, f: (home: string) => Promise<T>): Promise<T> {
  const why = stopped.get(source);
  if (why) throw new CliError(`codex: login handling stopped earlier in this run (${why}); no further Codex calls`, "access:login_conflict", false, true);
  if (!existsSync(source)) throw new CliError(`codex: no login at ${source} (run codex login); no other path is tried`, "access:no_login", false, true);
  const home = mkdtempSync(join(tmpdir(), "gen-codexhome-")), copy = join(home, "auth.json");
  try {
    const original = await serial(source, () => { const b = readFileSync(source); copyFileSync(source, copy); chmodSync(copy, 0o600); return b; });
    let result: T | undefined, err: unknown, failed = false;
    try { result = await f(home); } catch (e) { err = e; failed = true; }
    await serial(source, () => {
      if (!existsSync(copy)) return;
      const now = readFileSync(copy);
      if (now.equals(original)) return;
      const cur = existsSync(source) ? readFileSync(source) : Buffer.alloc(0);
      let why = sha(cur) === sha(original) ? "" : `${source} changed since it was copied`;
      if (!why) {
        const lock = `${source}.pgaibench-lock`;
        let fd: number | undefined;
        try { fd = openSync(lock, "wx", 0o600); } catch { why = `the lock file ${lock} exists (another write-back runs, or a stale lock: check, then remove it)`; }
        if (fd !== undefined) {
          try {
            closeSync(fd);
            const bak = `${source}.pgaibench-bak`;
            if (!backedUp.has(source) && !existsSync(bak)) createOnly600(bak, original);
            backedUp.add(source);
            atomicWrite600(source, now, () => {
              codexLoginHooks.beforeRename?.();
              const again = existsSync(source) ? readFileSync(source) : Buffer.alloc(0);
              if (sha(again) !== sha(original)) throw new LoginChanged();
            });
            codexLoginLog.written_back++;
            return;
          } catch (e) {
            if (!(e instanceof LoginChanged)) throw e;
            why = `${source} changed right before the rename`;
          } finally { rmSync(lock, { force: true }); }
        }
      }
      const base = stash ?? mkdtempSync(join(tmpdir(), "gen-codex-login-"));
      mkdirSync(base, { recursive: true, mode: 0o700 });
      const keep = mkdtempSync(join(base, "refreshed-"));
      chmodSync(keep, 0o700);
      atomicWrite600(join(keep, "auth.json"), now);
      codexLoginLog.conflicts++;
      const msg = `the CLI refreshed the Codex login, but ${why}; not written back. Refreshed copy kept in ${keep} (mode 700). Check \`codex login status\`; Codex cells stop`;
      stopped.set(source, msg);
      throw new CliError(`codex: ${msg}`, "access:login_conflict", false, true);
    });
    if (failed) throw err;
    return result as T;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
