// ssh -L forwarding from local ephemeral ports to VM-local Postgres ports
// (env binds PostgreSQL to 127.0.0.1 on the VM).

import { sshOptions } from "../actor/host";

export interface Tunnel { ports: Record<number, number>; close(): Promise<void> }

export function tunnelArgs(ip: string, map: Record<number, number>): string[] {
  const fwd = Object.entries(map).flatMap(([remote, local]) => ["-L", `127.0.0.1:${local}:127.0.0.1:${remote}`]);
  return [...sshOptions(), "-o", "ExitOnForwardFailure=yes", "-N", ...fwd, `root@${ip}`];
}

export async function openTunnel(ip: string, remotePorts: number[]): Promise<Tunnel> {
  const map: Record<number, number> = {};
  for (const r of remotePorts) {
    const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    map[r] = l.port;
    l.stop(true);
  }
  const proc = Bun.spawn(["ssh", ...tunnelArgs(ip, map)], { stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(proc.stderr).text();
  const close = async () => { proc.kill(); await proc.exited; };
  const deadline = Date.now() + 20_000;
  const first = map[remotePorts[0]!]!;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`ssh tunnel to ${ip} failed: ${await stderr}`);
    try {
      const s = await Bun.connect({ hostname: "127.0.0.1", port: first, socket: { data() {}, error() {} } });
      s.end();
      return { ports: map, close };
    } catch { await Bun.sleep(150); }
  }
  await close();
  throw new Error(`ssh tunnel to ${ip} timed out`);
}
