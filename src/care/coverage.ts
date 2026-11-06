// A clean report only means something next to what it looked at: most apps unchecked, no score. Shared by the server and
// the web app, so they can never disagree.
export interface CoverageLike { apps: { checked: number; found: number } }
export const lowCoverage = (c?: CoverageLike) => !!c && c.apps.found > 0 && c.apps.checked * 2 < c.apps.found;
