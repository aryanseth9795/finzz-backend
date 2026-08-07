/**
 * Escape every character that carries meaning inside a regular expression, so
 * user input can be used as a literal substring in a `$regex` query.
 *
 * Two distinct problems this solves:
 *
 *  1. Correctness — a search for "(work)" previously produced an invalid
 *     pattern and a 500 from the driver, because the parentheses were parsed
 *     as a capture group.
 *
 *  2. Availability — a pattern such as `(a+)+$` triggers catastrophic
 *     backtracking (ReDoS). MongoDB evaluates regexes server-side, so an
 *     unescaped search box lets any caller pin a database thread with a
 *     handful of characters.
 */
export const escapeRegex = (input: string): string =>
  input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest search term accepted. Bounds the work a single query can request. */
export const MAX_SEARCH_LENGTH = 64;

/**
 * Turn arbitrary user input into a safe case-insensitive "contains" matcher,
 * or `null` when there is nothing to search for.
 */
export const buildSearchRegex = (
  input: unknown,
): { $regex: string; $options: string } | null => {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().slice(0, MAX_SEARCH_LENGTH);
  if (!trimmed) return null;
  return { $regex: escapeRegex(trimmed), $options: "i" };
};
