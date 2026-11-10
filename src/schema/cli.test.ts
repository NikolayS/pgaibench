import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCR } from '../telemetry/fixtures';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function invoke(args: string[]) {
  const p = Bun.spawn([process.execPath, 'src/schema/cli.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); return { code, out, err };
}
test('CLI prints validated JSON on stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-cli-')); dirs.push(dir); const path = join(dir, 'cr.json'); await Bun.write(path, JSON.stringify(fixtureCR()));
  const result = await invoke([path]); expect(result.code).toBe(0); expect(JSON.parse(result.out).id).toBe('test'); expect(result.err).toBe('');
});
test('CLI prints validation paths on stderr and exits nonzero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-cli-')); dirs.push(dir); const path = join(dir, 'cr.json'); await Bun.write(path, JSON.stringify({ ...fixtureCR(), rollback: [] }));
  const result = await invoke([path]); expect(result.code).toBe(1); expect(result.err).toContain('rollback'); expect(result.out).toBe('');
});
test('CLI handles malformed JSON and missing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pgaibench-cli-')); dirs.push(dir); const path = join(dir, 'cr.json'); await Bun.write(path, '{');
  expect((await invoke([path])).code).toBe(1); expect((await invoke([join(dir, 'missing.json')])).err).toContain('Cannot validate');
});
test('CLI documents usage and requires one file', async () => { expect((await invoke(['--help'])).code).toBe(0); expect((await invoke([])).code).toBe(2); });
