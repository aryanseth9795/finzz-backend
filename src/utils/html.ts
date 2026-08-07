/**
 * HTML escaping for the PDF/report builders.
 *
 * Both export builders assembled their documents with template literals,
 * interpolating `tx.remarks`, user names and phone numbers directly:
 *
 *     `<td>${tx.remarks}</td>`
 *
 * The resulting HTML is rendered by `expo-print` inside a WebView on the
 * mobile client, where `<script>` and `<img onerror=…>` execute. That made a
 * transaction remark a stored-XSS vector: text written by one user executed in
 * the other user's app when they exported a statement.
 *
 * Escaping at the point of interpolation is the correct layer — sanitising on
 * input would corrupt legitimate remarks like "R&D < budget", and would have
 * to be repeated for every future output format.
 */

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;",
};

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 *
 * `'`, backtick and `=` are escaped in addition to the usual four because
 * unquoted attribute values are a real pattern in hand-written templates, and
 * without them `onerror=alert(1)` survives inside `<img src=x ...>`.
 */
export const escapeHtml = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`=]/g, (char) => HTML_ENTITIES[char]);
};

/**
 * Tagged template that escapes every interpolated value automatically.
 *
 * Using `html\`<td>${remarks}</td>\`` makes the safe path the default one:
 * forgetting to call `escapeHtml` is no longer possible, because the tag runs
 * on every substitution. Values already produced by this tag are passed
 * through unescaped via `raw()`, so fragments can be composed.
 */
class SafeHtml {
  constructor(public readonly value: string) {}
  toString() {
    return this.value;
  }
}

/** Mark a string as already-safe HTML (markup you generated, not user input). */
export const raw = (value: string): SafeHtml => new SafeHtml(value);

export const html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): string => {
  return strings.reduce((acc, str, i) => {
    if (i === 0) return str;
    const value = values[i - 1];
    const rendered =
      value instanceof SafeHtml
        ? value.value
        : Array.isArray(value)
          ? value
              .map((v) => (v instanceof SafeHtml ? v.value : escapeHtml(v)))
              .join("")
          : escapeHtml(value);
    return acc + rendered + str;
  }, "");
};

/** Format a number as Indian-locale currency for reports. */
export const formatCurrency = (amount: number): string =>
  `₹${Number(amount || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
