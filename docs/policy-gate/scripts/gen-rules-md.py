#!/usr/bin/env python3
"""Regenerate spec/03-rules.md from rules/rules.yaml. Run from the pack root."""
import yaml, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
d = yaml.safe_load((root / 'rules/rules.yaml').read_text())
r = d['rules']
out = ["# 03 — Policy rules", "",
"Generated from `rules/rules.yaml` (the source of truth) by `scripts/gen-rules-md.py`.",
f"{len(r)} rules; each returns **reject** (back to the Analyst with rule ID, reason and",
"fix hint), **defer** (state is temporarily unsafe; recheck every 10s for up to D_budget,",
"then escalate) or",
"**escalate** (human decides).", "",
"Prefixes: `TS` ticket scope, `R` replication/settings, `L` locking, `X` transaction",
"structure, `I` indexes, `U` object usage, `T` type safety, `S` scale.", "",
"`scope: plan` rules evaluate the whole ordered CR (ordering, transaction grouping);",
"`scope: step` rules evaluate one step against `Σ`.", "", "## Thresholds", "",
"| Name | Default | Meaning |", "| --- | --- | --- |"]
for k, v in d['thresholds'].items():
    out.append(f"| `{k}` | {v['value']} | {v['meaning']} |")
out += ["", "## Rules", "",
        "| Rule | Scope | Applies to | Condition | On failure | Targets |",
        "| --- | --- | --- | --- | --- | --- |"]
for x in r:
    pre = x['condition'].strip().replace('\n', ' ')
    if x.get('settings'): pre += f" Settings: {', '.join(x['settings'])}."
    if x.get('fix_hint'): pre += f" Fix: {x['fix_hint']}"
    out.append(f"| `{x['id']}` | {x['scope']} | {', '.join('`'+a+'`' for a in x['applies_to'])} | {pre} | {x['verdict']} | {', '.join(x['targets']) or '—'} |")
out += ["", "## Actor postconditions", ""]
for p in d['postconditions']:
    out.append(f"- After `{p['after']}`: {p['check']}")
out += ["", "## Notes", "",
"- The R-2 settings are the ones a hot standby must match or exceed (PG docs, Hot Standby).",
"- Numeric parts of R-1, R-2 and R-4 are small linear constraints; an SMT solver is",
"  optional today but a natural fit if setting interdependencies grow (spec/06).",
"- Ordering rules (R-2, R-3, X-2, X-4) are the best candidates for TLA+ verification.",
"- R-5 (postmaster setting changed without a restart) was retired: the Actor always restarts",
"  after a config step on a postmaster setting, and ALTER SYSTEM in SQL steps is denied (ADR 0003)."]
(root / 'spec/03-rules.md').write_text('\n'.join(out) + '\n')
print(f"wrote spec/03-rules.md ({len(r)} rules)")
