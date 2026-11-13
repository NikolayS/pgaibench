// The tagged release of the benchmark. Bump with package.json and CHANGELOG.md (see RELEASING.md).
const REPO = 'https://github.com/NikolayS/pgaibench';

export const RELEASE = { version: '0.1.1', date: '2026-11-13' } as const;
export const RELEASE_TAG = `v${RELEASE.version}`;
/** The release that the live five-run table becomes. When RELEASE.version reaches it (the release commit), the live pages drop "provisional". */
export const NEXT = '0.1.1';
export const LIVE_TAGGED = RELEASE.version === NEXT;
/** " (provisional)" before the tag, "" after. */
export const PROV = LIVE_TAGGED ? '' : ' (provisional)';
/** The release line under the chart. */
export const releaseState = () => (LIVE_TAGGED ? `Release v${NEXT}. Earlier release:` : `Provisional until tagged v${NEXT}. Release of record:`);
export const RELEASE_URL = `${REPO}/releases/tag/${RELEASE_TAG}`;
export const CHANGELOG_URL = `${REPO}/blob/main/CHANGELOG.md`;
/** Commits on public main after the tag; 0 is the tagged state. */
export type ReleaseState = { ahead: number; /** the shown results equal the frozen table of the release (only code or head tags changed) */ released?: boolean; /** data time (UTC) of the tagged build; later refreshes are after the release */ cutoff?: string };
/** One line: the tagged state, or how far a later build is from it. */
export function releaseLine(r: ReleaseState | undefined): string {
  const a = `<a href="${RELEASE_URL}">Release ${RELEASE_TAG}, tagged ${RELEASE.date}</a>`;
  return !r || r.ahead === 0 || r.released ? a : `${a}; this build: ${RELEASE_TAG} + ${r.ahead} change${r.ahead === 1 ? '' : 's'} (unreleased)`;
}
/** The header mark next to the site name: "v0.1.0 (2026-11-11)", linking the GitHub release. Nothing more. */
/** Tagged releases, newest first: one line each on the releases page. A release appears here once tagged. */
export const RELEASES: { version: string; date: string; page: string }[] = [
  ...(LIVE_TAGGED ? [{ version: NEXT, date: RELEASE.date, page: `releases/v${NEXT}/` }] : []),
  { version: '0.1.0', date: '2026-11-11', page: 'releases/v0.1.0/' },
];
/** Small version mark in the footer of a live page. */
export const footVersion = (r: ReleaseState | undefined, build?: string) => (!r || r.ahead === 0 || r.released ? `${RELEASE_TAG}, ${RELEASE.date}${build ? `, build ${build}` : ''}` : `unreleased, after ${RELEASE_TAG}`);
export const versionLink = (tag: string = RELEASE_TAG, date: string = RELEASE.date) => `<a class="ver" href="${REPO}/releases/tag/${tag}">${tag} (${date})</a>`;
