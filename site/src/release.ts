// Tagged releases of the benchmark. A release is one entry in RELEASE_LIST plus its snapshot file under
// site/content; site/src/bump.ts adds both (see RELEASING.md). Every label on the site derives from this list.
const REPO = 'https://github.com/NikolayS/pgaibench';

export type Release = {
  version: string; /** UTC date of the tag */ date: string; /** runs per task in its table */ runs: number;
  /** its table as published with the tag (site/content), the parsed data/pooled.json of the tagged build */ snapshot: string;
  /** data time (UTC) of the tagged build: refreshes up to it belong to this release */ cutoff: string;
  /** task-set label of the release (frozen pages show it) */ taskSet: string;
};
/** Oldest first. Append only: the bump step adds the newest entry. */
export const RELEASE_LIST: readonly Release[] = [
  { version: '0.1.0', date: '2026-11-11', runs: 3, snapshot: 'record-v0.1.0-pooled.json', cutoff: '2026-11-11T19:31:43Z', taskSet: 'pgaibench-core 0.1.0' },
  { version: '0.1.1', date: '2026-11-13', runs: 5, snapshot: 'record-v0.1.1-pooled.json', cutoff: '2026-11-13T06:31:36Z', taskSet: 'pgaibench-core 0.1.0' },
];

export const RELEASE = RELEASE_LIST.at(-1)!;
export const RELEASE_TAG = `v${RELEASE.version}`;
export const RELEASE_URL = `${REPO}/releases/tag/${RELEASE_TAG}`;
export const CHANGELOG_URL = `${REPO}/blob/main/CHANGELOG.md`;
export const tagUrl = (v: string) => `${REPO}/releases/tag/v${v}`;
/** The page of the frozen table of a release. */
export const releasePage = (v: string) => `releases/v${v}/`;
/** Tagged releases, newest first: one line each on the releases page. */
export const RELEASES: { version: string; date: string; page: string; runs: number }[] = [...RELEASE_LIST].reverse().map(r => ({ version: r.version, date: r.date, page: releasePage(r.version), runs: r.runs }));
/** The release a refresh belongs to: the first whose cutoff is at or after it; null after the newest. */
export const releaseOf = (at: string) => RELEASE_LIST.find(r => at <= r.cutoff) ?? null;

/** Commits on public main after the tag; 0 is the tagged state. */
export type ReleaseState = { ahead: number; /** the shown results equal the newest frozen table (only code or text changed) */ released?: boolean; cutoff?: string };
export const isReleased = (r: ReleaseState | undefined) => !r || r.ahead === 0 || !!r.released;
/** The release line under the chart: the state of the shown table, then every release with its frozen page. */
export const releaseState = (r: ReleaseState | undefined) => (isReleased(r) ? `Release ${RELEASE_TAG}.` : `Unreleased, after ${RELEASE_TAG}.`);
/** One line: the tagged state, or how far a later build is from it. */
export function releaseLine(r: ReleaseState | undefined): string {
  const a = `<a href="${RELEASE_URL}">Release ${RELEASE_TAG}, tagged ${RELEASE.date}</a>`;
  return isReleased(r) ? a : `${a}, this build: ${RELEASE_TAG} + ${r!.ahead} change${r!.ahead === 1 ? '' : 's'} (unreleased)`;
}
/** The release state in words for machine-readable text: "release v0.1.1" or "unreleased, after v0.1.1". */
export const stateLabel = (r: ReleaseState | undefined) => (isReleased(r) ? `release ${RELEASE_TAG}` : `unreleased, after ${RELEASE_TAG}`);
/** Small version mark in the footer of a live page. */
export const footVersion = (r: ReleaseState | undefined, build?: string) => (isReleased(r) ? `${RELEASE_TAG}, ${RELEASE.date}${build ? `, build ${build}` : ''}` : `unreleased, after ${RELEASE_TAG}`);
export const versionLink = (tag: string = RELEASE_TAG, date: string = RELEASE.date) => `<a class="ver" href="${REPO}/releases/tag/${tag}">${tag} (${date})</a>`;
