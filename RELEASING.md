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

The date of a release is the UTC date of its tag.

1. Run `bun test` twice. Both runs must be green.
2. Read the diff since the last tag. It must hold no held-out task
   content, no person names, no secrets and no local paths.
3. Build the site with the results of the release and publish it. Keep
   two things of that build: `data/pooled.json` (the table of the
   release) and `data_at` in `data/provisional.json` (its data time).
4. Run the release step:
   `bun run site/src/bump.ts X.Y.Z YYYY-MM-DD <pooled.json> <data time>`.
   It writes `site/content/record-vX.Y.Z-pooled.json` (the frozen table),
   adds the release to `RELEASE_LIST` in `site/src/release.ts`, sets the
   version in `package.json`, and turns "Unreleased" in CHANGELOG.md into
   `## [X.Y.Z] - YYYY-MM-DD` with its link line. The section must state
   the task-set version and the model input version.
5. Run `bun test` again. A test checks that `package.json`,
   `RELEASE_LIST` and the newest changelog section agree.
6. Commit, then tag the commit on `main`:
   `git tag -a vX.Y.Z -m "PGAIBench vX.Y.Z"`. Push `main` and the tag.
7. Build the site again from the tagged commit and publish it. The footer
   now reads "vX.Y.Z, YYYY-MM-DD", the releases page lists the release,
   and `releases/vX.Y.Z/` shows its table. Tag the published `gh-pages`
   commit `site-vX.Y.Z` and push that tag.
8. `gh release create vX.Y.Z --title "PGAIBench vX.Y.Z" --notes-file <file>
   --verify-tag`, with the changelog section as the notes.
9. Check: `git ls-remote --tags origin` lists both tags, the release page
   loads, and every release page on the site loads.

After the tag, a build whose table differs from the newest frozen table
shows "unreleased, after vX.Y.Z". A build that changes only code or text
keeps the release mark.

## Corrections to a tagged table

A tagged table never changes. Add the correction to
`site/src/corrections.ts` with its date and data time. The results page
lists it, `data/corrections.json` names the releases it touches, and the
page of each touched release gets a dated line that points to it. Add a
dated "Corrections" section to the GitHub release notes of each touched
release.
