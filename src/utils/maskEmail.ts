/**
 * Mask an email for display: enough for the owner to recognise which inbox to
 * check, not enough to reveal the address. "aryan.seth51@gmail.com" →
 * "ar********51@gmail.com"; short local parts are masked more heavily.
 */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf("@");
  if (at < 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const n = local.length;
  if (n <= 1) return `*${domain}`;
  if (n <= 4) return `${local[0]}${"*".repeat(n - 1)}${domain}`;
  return `${local.slice(0, 2)}${"*".repeat(n - 4)}${local.slice(-2)}${domain}`;
};
