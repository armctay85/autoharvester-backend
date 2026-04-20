// ─────────────────────────────────────────────────────────────────────────────
//  CSV serialiser
//
//  Zero-dependency CSV writer that handles the gnarly bits properly:
//    - quoting fields containing comma, quote, newline, or carriage return
//    - escaping embedded quotes (RFC 4180: " → "")
//    - flattening nested objects/arrays via JSON.stringify
//    - null / undefined → empty cell
//    - Date → ISO 8601
//
//  Used by the dealer dashboard to download alerts and inventory snapshots.
//  Kept dependency-free so it can be unit-tested without DB/env.
// ─────────────────────────────────────────────────────────────────────────────

const CRLF = '\r\n';

function serialiseValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  // arrays / objects
  return JSON.stringify(v);
}

function escapeCell(raw: string): string {
  if (raw === '') return '';
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Serialise an array of plain objects to CSV. Column order is taken from
 * the keys of the first row unless `columns` is supplied.
 */
export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns?: Array<keyof T | string>
): string {
  if (!rows.length) {
    return columns?.length ? columns.map((c) => escapeCell(String(c))).join(',') + CRLF : '';
  }
  const cols = (columns ?? Object.keys(rows[0]!)) as string[];
  const header = cols.map((c) => escapeCell(c)).join(',');
  const body = rows
    .map((row) =>
      cols.map((c) => escapeCell(serialiseValue((row as Record<string, unknown>)[c]))).join(',')
    )
    .join(CRLF);
  return `${header}${CRLF}${body}${CRLF}`;
}

/**
 * Build a Content-Disposition header value for downloading the CSV with a
 * sensible default filename.
 */
export function csvAttachmentDisposition(filename: string): string {
  // Strip anything that could escape the header value.
  const safe = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `attachment; filename="${safe}"`;
}
