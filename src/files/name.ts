/**
 * File names and types as the owner sees them. Without node dependencies,
 * because the web interface uses the same code before sealing (vault files),
 * and without the i18n catalog for the same reason: whatever needs the owner's
 * language gets it from the caller.
 */

/** A media type as it may appear in a mail. */
export const MIME_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,80}$/;

/** Characters that appear in no file name the owner or the model sees. */
export const FILE_NAME_FORBIDDEN = /[\u0000-\u001f\u007f<>"`\\/]/;

/**
 * What the owner sees, without line breaks and angle brackets: a file name
 * carries no instruction and no tag. `fallback` is the name for a file that
 * came without one; server code passes it in the owner's language
 * (`media.unnamedPdf`, `media.unnamedFile`), the web interface keeps the
 * English default.
 */
export function cleanFileName(raw: string, mimeType: string, fallback?: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>"`]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return fallback ?? (mimeType === "application/pdf" ? "document.pdf" : "file");
  if (clean.length <= 120) return clean;
  const ext = /\.[A-Za-z0-9]{1,6}$/.exec(clean)?.[0] ?? "";
  return `${clean.slice(0, 120 - ext.length - 1).trimEnd()}…${ext}`;
}

const KB = 1024;
const MB = 1024 * 1024;

/**
 * "857 B", "12 KB", "1.2 MB" (or "1,2 MB" with `de`). The number follows
 * `locale`: English by default, which is right for every text to the model.
 * A fixed text to the owner passes the locale of its frame,
 * `currentLocale(textLanguage(message))`, so number and words match; the web
 * interface passes its own.
 */
export function formatSize(bytes: number, locale = "en"): string {
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: false });
  if (bytes < KB) return `${whole.format(bytes)} B`;
  if (bytes < MB) return `${whole.format(Math.round(bytes / KB))} KB`;
  const tenths = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
  return `${tenths.format(bytes / MB)} MB`;
}
