/**
 * reports/_cargowise.ts
 *
 * Shared parsing helpers for CargoWise HHH report exports.
 *
 * These xlsx files are NOT clean tables: they may carry a #config/definition
 * sheet, several title rows above the real header, comma-formatted numbers,
 * parenthesised negatives, serial-number dates, and trailing "*" flags.
 */

import * as XLSX from 'xlsx';

/**
 * Pick the worksheet that holds the actual data.
 * CargoWise "report template" exports put a #config/definition sheet first
 * (plus Filter/GroupBys/Sort/Optional Templates sheets), with the rendered
 * data on a separate sheet. Strategy: drop any sheet whose first cell is
 * "#config", then choose the remaining sheet with the most rows.
 */
function pickDataSheet(wb: XLSX.WorkBook): string {
  const rowCount = (sn: string) =>
    (XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false }) as unknown[][]).length;
  const isConfig = (sn: string) => {
    const m = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false }) as unknown[][];
    return String(m[0]?.[0] ?? '').trim().toLowerCase() === '#config';
  };
  const pool = wb.SheetNames.filter(sn => !isConfig(sn));
  const candidates = pool.length ? pool : wb.SheetNames;
  let best = candidates[0];
  let bestRows = -1;
  for (const sn of candidates) {
    const n = rowCount(sn);
    if (n > bestRows) { bestRows = n; best = sn; }
  }
  return best;
}

/** Read the data worksheet as a raw matrix (array of row-arrays). */
export function readMatrix(buffer: Buffer): unknown[][] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheet = wb.Sheets[pickDataSheet(wb)];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
    raw: true,
  });
}

/** Normalise a cell value to a lowercase, single-spaced, trimmed string. */
export function norm(v: unknown): string {
  return String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Trim to a string or null (empty -> null). */
export function str(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/** Parse a CargoWise number: handles commas, parenthesised negatives, blanks. */
export function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isNaN(raw) ? null : raw;
  let s = String(raw).trim();
  if (s === '' || s === '-' || s === '*') return null;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) s = '-' + paren[1];
  s = s.replace(/,/g, '').replace(/[$%]/g, '').trim();
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse a date cell (xlsx serial, "DD-Mon-YY", or other string) to ISO, or null. */
export function parseDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const days = Math.floor(raw);
    const ms = Math.round((raw - days) * 86400000);
    const dt = new Date(Date.UTC(1899, 11, 30) + days * 86400000 + ms);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    const mon = MONTHS[m[2].toLowerCase()];
    let yr = Number(m[3]);
    if (yr < 100) yr += 2000;
    if (mon) return `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Find the index of the first row that contains ALL given label substrings
 * (each compared against the normalised cells of the row). Returns -1 if none.
 */
export function findHeaderRow(matrix: unknown[][], required: string[]): number {
  for (let i = 0; i < matrix.length; i++) {
    const cells = (matrix[i] ?? []).map(norm);
    if (required.every(req => cells.some(c => c.includes(req)))) return i;
  }
  return -1;
}

/** First column index whose normalised header satisfies the predicate, or -1. */
export function colIndex(header: unknown[], pred: (c: string) => boolean): number {
  return header.findIndex(c => pred(norm(c)));
}

/** Build a {header: value} object for a row, for the raw_row JSONB column. */
export function rawRowObject(header: unknown[], row: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  header.forEach((h, i) => {
    const key = String(h ?? '').trim();
    if (key) obj[key] = row[i] ?? null;
  });
  return obj;
}

/** Default fiscal period label (YYYYMM) derived from an ISO date. */
export function periodFromDate(isoDate: string): string {
  return isoDate.replace(/-/g, '').slice(0, 6);
}

/** True if any cell in the row is exactly "*" (CargoWise over-credit-limit flag). */
export function hasStarFlag(row: unknown[]): boolean {
  return row.some(c => String(c ?? '').trim() === '*');
}

/** Upsert rows into a staging table in chunks. */
export async function upsertStaging(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  logger: { info: (m: string, x?: unknown) => void },
): Promise<void> {
  logger.info(`Upserting into staging.${table}`, { count: rows.length });
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .schema('staging')
      .from(table)
      .upsert(chunk, { onConflict });
    if (error) throw new Error(`staging.${table} upsert failed: ${error.message}`);
  }
}
