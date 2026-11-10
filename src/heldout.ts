// Held-out scenarios are private. Their ids are in private/held-out.json,
// which the public tree does not contain. There the list is empty, and the
// tests that need held-out material (files named *.heldout.test.ts) are
// not present either.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const HELD_OUT_FILE = join(import.meta.dir, '..', 'private', 'held-out.json');

export function loadHeldOut(file = HELD_OUT_FILE): string[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { ids: string[] }).ids : [];
}

export const HELD_OUT: readonly string[] = loadHeldOut();
export const heldOutPresent = HELD_OUT.length > 0;
export const isHeldOut = (id: string) => HELD_OUT.includes(id);
