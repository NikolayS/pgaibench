import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cleanupTmp, fake, trackTmp } from "./fake-cli-helper";

test("test temp dirs (trackTmp, fake roots) are removed by cleanupTmp", () => {
  const a = trackTmp("gen-"), f = fake("codex", []);
  expect(existsSync(a) && existsSync(f.home)).toBe(true);
  cleanupTmp();
  expect(existsSync(a) || existsSync(f.home) || existsSync(f.d)).toBe(false);
});
