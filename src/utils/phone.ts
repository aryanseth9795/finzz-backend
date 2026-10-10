/**
 * Phone formats.
 *
 * Every account created before the app normalised to E.164 stores its phone
 * as 10 bare digits ("9795785251"); the current app sends "+919795785251",
 * and older builds may send either. Exact-match lookups therefore failed for
 * every existing user — nobody could log in. Lookups go through these helpers
 * so all formats of an Indian number find the same account, without
 * rewriting stored data.
 */

/** The 10-digit national number for an Indian phone in any common format, else null. */
const indianLocal = (input: string): string | null => {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && !raw.startsWith("+")) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
};

/** Every stored form an incoming phone may correspond to, for `{ $in: … }` lookups. */
export const phoneVariants = (input: string): string[] => {
  const local = indianLocal(input);
  return local ? [local, `+91${local}`, `91${local}`] : [input.trim()];
};

/** One comparison key per number, so different formats of it compare equal. */
export const canonicalPhone = (input: string): string => indianLocal(input) ?? input.trim();
