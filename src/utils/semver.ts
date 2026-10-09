/** Strict MAJOR.MINOR.PATCH — the only shape app.json `version` takes. */
const SEMVER = /^\d+\.\d+\.\d+$/;

export const isValidVersion = (v: unknown): v is string =>
  typeof v === "string" && SEMVER.test(v);

/** -1 if a < b, 0 if equal, 1 if a > b. Numeric per segment: 1.10.0 > 1.9.0. */
export const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
};
