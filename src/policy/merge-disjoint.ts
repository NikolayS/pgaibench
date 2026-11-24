/**
 * One table from several, one per family. A key in two tables is an error,
 * not an override; `what` names the key in the message (e.g. "rule").
 */
export function mergeDisjoint<T>(what: string, ...tables: Record<string, T>[]): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const table of tables) {
    for (const [key, value] of Object.entries(table)) {
      if (Object.hasOwn(merged, key)) throw new Error(`${what} ${key} is in two family tables`);
      merged[key] = value;
    }
  }
  return merged;
}
