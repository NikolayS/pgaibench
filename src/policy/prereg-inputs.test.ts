// Guard: the policy gate preregistration (docs/prereg-policy-gate.md) freezes
// the rule data and the ticket scope files. prereg-inputs.sha256 pins the
// sha256 of src/policy/rules.yaml and of every file in src/policy/scopes/,
// in the pattern of src/scenarios/frozen-inputs.test.ts.
//
// STATUS: DRAFT. The preregistration is not frozen yet, so these pins only
// record the drafted inputs. While it is a draft, a deliberate change to the
// rule data or a scope file is fine: re-pin from the repo root with
//
//   sha256sum src/policy/rules.yaml src/policy/scopes/*.json > src/policy/prereg-inputs.sha256
//
// then copy the new rules.yaml hash and the hash of the pin file itself
// (sha256sum src/policy/prereg-inputs.sha256) into the "Frozen inputs"
// section of docs/prereg-policy-gate.md. When a human freezes the
// preregistration, they re-pin once at the freeze commit and record that
// commit in the document; after that, a change needs a dated amendment.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PIN_FILE = join(import.meta.dir, "prereg-inputs.sha256");

const pinned = existsSync(PIN_FILE)
  ? readFileSync(PIN_FILE, "utf8").trim().split("\n").map((l) => {
      const [sha, path] = l.split(/\s+/);
      return { sha: sha!, path: path! };
    })
  : [];

const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");

test("the pin list covers exactly the rule data and every ticket scope file", () => {
  const expected = ["src/policy/rules.yaml", ...readdirSync(join(ROOT, "src/policy/scopes")).filter((f) => f.endsWith(".json")).map((f) => `src/policy/scopes/${f}`)].sort();
  expect(pinned.map((p) => p.path).sort()).toEqual(expected);
  // 31 scope files: the public scenarios plus the Track 2 corpus scenarios (#5).
  expect(pinned.filter((p) => p.path.startsWith("src/policy/scopes/")).length).toBe(31);
});

test("the rule data and scope files are byte-identical to their pins", () => {
  const changed = pinned.filter(({ sha, path }) => !existsSync(join(ROOT, path)) || sha256(path) !== sha).map((p) => p.path);
  expect(changed).toEqual([]);
});
