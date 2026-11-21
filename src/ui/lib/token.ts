/**
 * Portal-token hand-off for the standalone SPA: a host links its customer to
 * `https://app.example.com/billing/#token=entpt_…` (the fragment never reaches
 * servers or access logs); `?token=` works too. Pure — the caller passes the
 * location and a history writer. Unit-tested in `test/ui-lib.test.ts`.
 *
 * @module
 */

/**
 * Read a portal token from `#token=` (preferred) or `?token=`, and strip it
 * from the URL through `replace` (e.g. `history.replaceState`). Returns the
 * token, or `null` when the URL carries none.
 */
export function takeTokenFromUrl(
  location: Pick<Location, "hash" | "search" | "pathname">,
  replace: (url: string) => void,
): string | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const search = new URLSearchParams(location.search);
  const token = hash.get("token") ?? search.get("token");
  if (!token) return null;
  hash.delete("token");
  search.delete("token");
  const s = search.toString();
  const h = hash.toString();
  replace(`${location.pathname}${s ? `?${s}` : ""}${h ? `#${h}` : ""}`);
  return token;
}
