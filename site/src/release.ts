// The tagged release of the benchmark. Bump with package.json and CHANGELOG.md (see RELEASING.md).
const REPO = 'https://github.com/NikolayS/pgaibench';

export const RELEASE = { version: '0.1.0', date: '2026-11-11' } as const;
export const RELEASE_TAG = `v${RELEASE.version}`;
export const RELEASE_URL = `${REPO}/releases/tag/${RELEASE_TAG}`;
export const CHANGELOG_URL = `${REPO}/blob/main/CHANGELOG.md`;
/** Commits on public main after the tag; 0 is the tagged state. */
export type ReleaseState = { ahead: number; /** data time (UTC) of the tagged build; later refreshes are after the release */ cutoff?: string };
/** One line: the tagged state, or how far a later build is from it. */
export function releaseLine(r: ReleaseState | undefined): string {
  const a = `<a href="${RELEASE_URL}">Release ${RELEASE_TAG}, tagged ${RELEASE.date}</a>`;
  return !r || r.ahead === 0 ? a : `${a}; this build: ${RELEASE_TAG} + ${r.ahead} change${r.ahead === 1 ? '' : 's'} (unreleased)`;
}
/** The header mark next to the site name: "v0.1.0 (2026-11-11)", linking the GitHub release. Nothing more. */
export const versionLink = () => `<a class="ver" href="${RELEASE_URL}">${RELEASE_TAG} (${RELEASE.date})</a>`;
