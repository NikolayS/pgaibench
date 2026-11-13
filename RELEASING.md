# Releasing

Versions are `MAJOR.MINOR.PATCH`, tagged `vMAJOR.MINOR.PATCH` on `main`.

- PATCH: fixes to text, the site, or a judging defect; more runs or more
  configurations on the same task set, model input and points.
- MINOR: new tasks, a new model input, or a change of the points.
- MAJOR: a new task set or scoring that makes results not comparable with
  earlier ones.

Each release states its task-set version (`pgaibench-core X.Y.Z`) and its
model input version in the changelog.

## Checklist

1. `bun test` green twice.
2. Scanner and leak pass clean: `bun run scripts/public-check.ts .` and a
   read of the diff for held-out task content, person names, secrets and
   local paths.
3. CHANGELOG.md: move "Unreleased" into a new section
   `## [X.Y.Z] - YYYY-MM-DD`; add the compare link at the bottom. The date
   is the UTC date of the tag.
4. Bump the version in `package.json` and `site/src/release.ts`
   (`RELEASE.version`, `RELEASE.date`); the site test checks that they agree
   with the newest changelog section.
5. Publish the site from this commit.
6. Tag: `git tag -a vX.Y.Z -m "PGAIBench vX.Y.Z"` on `main`, and
   `site-vX.Y.Z` on the published `gh-pages` commit; push both tags.
7. `gh release create vX.Y.Z --title "PGAIBench vX.Y.Z" --notes-file <file>`
   with the notes from the changelog section.
8. Verify: `git ls-remote --tags origin`, the release page loads, the site
   shows the release line.

Builds after a tag show "vX.Y.Z + N changes (unreleased)".
