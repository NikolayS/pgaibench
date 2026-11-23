# The policy gate's action vocabulary follows what the Actor actually does

Change requests have no restart step: the Actor restarts a node itself when a
config step sets a postmaster-context setting, and it already orders standby
and primary correctly for the hot-standby settings. The policy gate therefore
treats such a config step as implying a node restart, so the no-restart scope
rule catches C18, and the ordering rule fires only when a change request splits
nodes across steps. ALTER SYSTEM inside a SQL step is denied, because it would
bypass the Actor's ordering and restart handling; settings must go through
config steps.

## Considered Options

- Add an explicit restart step type to the change request schema, as the
  original design pack proposed. Rejected: it changes the frozen schema the
  Analyst prompt describes.
- Classify ALTER SYSTEM in SQL steps as config actions. Rejected: two paths to
  the same effect, one of which skips the Actor's safeguards.
