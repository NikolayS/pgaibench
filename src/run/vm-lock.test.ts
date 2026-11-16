// One batch process per lab VM: a kernel lock (flock) on the VM, held by an ssh session for the life of the batch.
import { expect, test } from "bun:test";
import { acquireVmLock, LOCK_BUSY_EXIT, VM_LOCK_PATH, VmBusyError, vmLockArgs, type LockProc } from "./vm-lock";

/** A fake VM: one flock path shared by every fake ssh session. */
function fakeVm() {
  let holder: number | null = null, next = 1;
  const spawn = (_args: string[]): LockProc => {
    const id = next++;
    let exit!: (c: number) => void;
    const exited = new Promise<number>((r) => { exit = r; });
    const lines: string[] = [];
    let wake: (() => void) | null = null;
    const push = (l: string) => { lines.push(l); wake?.(); };
    let code: number | null = null;
    const end = (c: number) => { if (code !== null) return; code = c; if (holder === id) holder = null; exit(c); wake?.(); };
    queueMicrotask(() => { if (holder === null) { holder = id; push("LOCKED"); } else end(LOCK_BUSY_EXIT); });
    return {
      async *lines() { for (;;) { if (lines.length) { yield lines.shift()!; continue; } if (code !== null) return; await new Promise<void>((r) => { wake = r; }); wake = null; } },
      exited, kill: () => end(143),
    };
  };
  return { spawn, held: () => holder !== null };
}

test("ssh command takes a non-blocking flock on the VM and keeps it while stdin stays open", () => {
  const a = vmLockArgs("192.0.2.1");
  expect(a[0]).toBe("ssh");
  expect(a.at(-2)).toBe("root@192.0.2.1");
  expect(a.at(-1)).toBe(`exec flock -n -E ${LOCK_BUSY_EXIT} ${VM_LOCK_PATH} sh -c 'echo LOCKED; exec cat >/dev/null'`);
  expect(VM_LOCK_PATH.startsWith("/run/")).toBe(true); // tmpfs: gone after a VM reboot
});

test("a second batch process on the same VM refuses to start while the first holds the lock", async () => {
  const vm = fakeVm();
  const first = await acquireVmLock("192.0.2.1", { spawn: vm.spawn });
  expect(vm.held()).toBe(true);
  await expect(acquireVmLock("192.0.2.1", { spawn: vm.spawn })).rejects.toBeInstanceOf(VmBusyError);
  expect(vm.held()).toBe(true); // the refused attempt did not take or break the lock
  await first.release();
  expect(vm.held()).toBe(false);
});

test("released on exit: after the holder ends (any way), the next batch gets the lock", async () => {
  const vm = fakeVm();
  const first = await acquireVmLock("192.0.2.1", { spawn: vm.spawn });
  first.proc.kill(); // the batch process died: its ssh session ends, the kernel drops the flock
  await first.proc.exited;
  const second = await acquireVmLock("192.0.2.1", { spawn: vm.spawn });
  expect(vm.held()).toBe(true);
  await second.release();
});

test("an ssh failure before LOCKED is an error, not a busy VM", async () => {
  const spawn = (): LockProc => ({ async *lines() {}, exited: Promise.resolve(255), kill() {} });
  const e = await acquireVmLock("192.0.2.1", { spawn }).catch((x) => x);
  expect(e).toBeInstanceOf(Error);
  expect(e).not.toBeInstanceOf(VmBusyError);
  expect(String(e.message)).toContain("255");
});

test("withVmLock: runs the batch inside the lock and releases it after a normal end or a throw", async () => {
  const { withVmLock } = await import("./vm-lock");
  const vm = fakeVm();
  expect(await withVmLock("192.0.2.1", async () => { expect(vm.held()).toBe(true); return 7; }, { spawn: vm.spawn })).toBe(7);
  expect(vm.held()).toBe(false);
  await expect(withVmLock("192.0.2.1", async () => { throw new Error("x"); }, { spawn: vm.spawn })).rejects.toThrow("x");
  expect(vm.held()).toBe(false);
});

test("withVmLock: a busy VM never starts the batch", async () => {
  const { withVmLock } = await import("./vm-lock");
  const vm = fakeVm();
  const first = await acquireVmLock("192.0.2.1", { spawn: vm.spawn });
  let ran = false;
  await expect(withVmLock("192.0.2.1", async () => { ran = true; }, { spawn: vm.spawn })).rejects.toBeInstanceOf(VmBusyError);
  expect(ran).toBe(false);
  await first.release();
});

test("batch.ts: both real batch paths run inside the VM lock (fake mode has no VM)", async () => {
  const src = await Bun.file(new URL("./batch.ts", import.meta.url)).text();
  expect(src.match(/await lockedOrFake\(host, fake, \(\) => runBatch\(/g)?.length).toBe(2);
});
