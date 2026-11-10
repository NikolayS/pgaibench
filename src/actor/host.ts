import { homedir } from 'node:os';
import type { HostResult } from '../schema/types';

/** The only ssh option set in the repo: lab VM host keys live in ~/.ssh/known_hosts_pgaibench. */
export function sshOptions(): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${homedir()}/.ssh/known_hosts_pgaibench`];
}
export function hostArgs(ip: string, cmd: string): string[] {
  if (typeof ip !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(ip)) throw new Error('Invalid host: expected an IP address or hostname');
  if (!cmd.trim() || cmd.includes('\0')) throw new Error('Invalid host command');
  return ['ssh', ...sshOptions(), `root@${ip}`, cmd];
}
export async function runOnHost(ip: string, cmd: string): Promise<HostResult> {
  const proc = Bun.spawn(hostArgs(ip, cmd), { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

export function tunnelArgs(ip: string, primaryPort: number, standbyPort: number): string[] {
  hostArgs(ip, 'true');
  for (const port of [primaryPort, standbyPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid forwarding port');
  if (primaryPort === standbyPort) throw new Error('Forwarding ports must differ');
  return ['ssh', ...sshOptions(), '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${primaryPort}:127.0.0.1:5432`, '-L', `127.0.0.1:${standbyPort}:127.0.0.1:5433`, `root@${ip}`];
}
export async function openHostTunnel(ip: string): Promise<import('../schema/types').HostTunnel> {
  hostArgs(ip, 'true');
  // Reserve distinct ephemeral ports, then let SSH bind them. SSH detects a race.
  const a = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const b = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const primaryPort = a.port, standbyPort = b.port; a.stop(true); b.stop(true);
  const proc = Bun.spawn(tunnelArgs(ip, primaryPort, standbyPort), { stdout: 'ignore', stderr: 'pipe' });
  const stderr = new Response(proc.stderr).text();
  const close = async () => { proc.kill(); await proc.exited; await stderr; };
  try {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (proc.exitCode != null) throw new Error(`SSH forwarding failed: ${await stderr}`);
      try {
        const socket = await Bun.connect({ hostname: '127.0.0.1', port: primaryPort, socket: { data() {}, error() {} } });
        socket.end(); return { primaryPort, standbyPort, close };
      } catch { await Bun.sleep(100); }
    }
    throw new Error('Timed out establishing SSH forwarding');
  } catch (error) { await close(); throw error; }
}
