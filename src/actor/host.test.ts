import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { hostArgs, runOnHost, sshOptions } from './host';
test('SSH uses BatchMode and keeps remote command in one argument', () => {
  expect(hostArgs('192.0.2.1', '/opt/pgaibench/env/io-util.sh 60')).toEqual(['ssh', ...sshOptions(), 'root@192.0.2.1', '/opt/pgaibench/env/io-util.sh 60']);
});
test('the one ssh option set pins the pgaibench known_hosts file', () => {
  const o = sshOptions().join(' ');
  expect(o).toContain(`UserKnownHostsFile=${homedir()}/.ssh/known_hosts_pgaibench`);
  expect(o).toContain('StrictHostKeyChecking=accept-new'); expect(o).toContain('BatchMode=yes');
  const { tunnelArgs } = require('./host');
  expect(tunnelArgs('192.0.2.1', 15432, 15433).join(' ')).toContain('known_hosts_pgaibench');
});
test.each(['-oProxyCommand=bad', 'host;touch /tmp/bad', '', 'user@host', 'host\nother'])('rejects invalid SSH host %s', async ip => {
  await expect(runOnHost(ip, 'true')).rejects.toThrow('Invalid host');
});
test('validation forwarding binds local loopback and exposes both PostgreSQL ports', async () => {
  const { tunnelArgs } = await import('./host');
  const args = tunnelArgs('192.0.2.1', 15432, 15433);
  expect(args).toContain('ExitOnForwardFailure=yes'); expect(args).toContain('127.0.0.1:15432:127.0.0.1:5432'); expect(args).toContain('127.0.0.1:15433:127.0.0.1:5433');
  expect(args.at(-1)).toBe('root@192.0.2.1'); expect(args).toContain('-N');
  expect(() => tunnelArgs('192.0.2.1', 0, 15433)).toThrow();
});
test('rejects missing host values at runtime', () => { expect(() => hostArgs(undefined as any, 'true')).toThrow('Invalid host'); });
