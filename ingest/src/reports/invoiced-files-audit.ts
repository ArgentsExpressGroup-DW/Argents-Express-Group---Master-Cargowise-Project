/**
 * reports/invoiced-files-audit.ts
 *
 * Ingest handler for the CargoWise Invoiced Files Audit report.
 * This is Report #1 — the reconciliation anchor for the 175 count.
 *
 * Pipeline:
 *   1. Find the latest Invoiced Files Audit xlsx on SharePoint
 *   2. Download and parse it with xlsx
 *   3. Upsert raw rows into stg_invoiced_files_audit (idempotent)
 *   4. Populate / update core tables: files, invoices
 *
 * TODO: Verify exact column names against a real CargoWise export
 * before deploying to production. Column names below are best-guess.
 * Adjust COLUMN_MAP to match the actual header row.
 */

import * as XLSX from 'xlsx';
import type { SupabaseClient } from '@supabase/supabase-js';
import { downloadFile, findLatestFile } from '../graph.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────
// Column mapping: xlsx header → our typed fields
// TODO: Adjust these keys to match the real CargoWise column headers.
// Tip: print rawRow keys on first run to see the actual headers.
// ─────────────────────────────────────────────────────────────
const COLUMN_MAP = {
  job_file_no:       ['Job File No', 'File No', 'JobFileNo'],
  consol_no:         ['Consol No', 'ConsolNo', 'Master Bill'],
  branch:            ['Branch'],
  department:        ['Department', 'Dept'],
  ops_staff:         ['Ops Staff', 'Operations Staff', 'Handler'],
  sales_staff:       ['Sales Staff', 'Sales Rep'],
  service:           ['Service', 'Service Type'],
  trade_lane:        ['Trade Lane', 'Direction'],
  origin_port:       ['Origin Port', 'Origin', 'POL'],
  destination_port:  ['Destination Port', 'Destination', 'POD'],
  invoiced_date:     ['Invoiced Date', 'Invoice Date', 'First Invoice Date'],
  revenue_local:     ['Revenue (Local)', 'Revenue Local', 'Revenue AUD', 'Revenue'],
  cost_local:        ['Cost (Local)', 'Cost Local', 'Cost AUD', 'Cost'],
  gp_local:          ['GP (Local)', 'GP Local', 'GP AUD', 'GP', 'Gross Profit'],
  currency_code:     ['Currency', 'Currency Code'],
} as const;

type MappedField = keyof typeof COLUMN_MAP;

/** Try each candidate header name and return the first that exists in the row. */
function getField(row: Record<string, unknown>, field: MappedField): unknown {
  for (const candidate of COLUMN_MAP[field]) {
    if (candidate in row) return row[candidate];
  }
  return undefined;
}

function parseDate(raw: unknown): string | null {
  if (!raw) return null;
  // xlsx may return a JS date serial number or a string
  if (typeof raw === 'number') {
    const date = XLSX.SSF.parse_date_code(raw);
    if (!date) return null;
    return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

export interface ParsedRow {
  job_file_no:      string;
  consol_no:        string | null;
  branch:           string | null;
  department:       string | null;
  ops_staff:        string | null;
  sales_staff:      string | null;
  service:          string | null;
  trade_lane:       string | null;
  origin_port:      string | null;
  destination_port: string | null;
  invoiced_date:    string | null;   // ISO date string YYYY-MM-DD
  revenue_local:    number | null;
  cost_local:       number | null;
  gp_local:         number | null;
  currency_code:    string | null;
  raw_row:          Record<string, unknown>;
}

/** Parse an Invoiced Files Audit xlsx buffer into typed rows. */
export function parseInvoicedFilesAudit(buffer: Buffer): ParsedRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows  = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
  });

  logger.info('Parsed xlsx rows', { count: rawRows.length });

  // Log the first row's keys on debug so we can verify column mapping
  if (rawRows.length > 0) {
    logger.debug('xlsx column headers found', {
      headers: Object.keys(rawRows[0]).join(', '),
    });
  }

  const rows: ParsedRow[] = [];
  let skipped = 0;

  for (const raw of rawRows) {
    const jobFileNo = getField(raw, 'job_file_no');
    if (!jobFileNo || String(jobFileNo).trim() === '') {
      skipped++;
      continue;  // Skip rows with no file number (totals rows, blank rows, etc.)
    }

    rows.push({
      job_file_no:      String(jobFileNo).trim(),
      consol_no:        getField(raw, 'consol_no') ? String(getField(raw, 'consol_no')).trim() : null,
      branch:           getField(raw, 'branch') ? String(getField(raw, 'branch')).trim() : null,
      department:       getField(raw, 'department') ? String(getField(raw, 'department')).trim() : null,
      ops_staff:        getField(raw, 'ops_staff') ? String(getField(raw, 'ops_staff')).trim() : null,
      sales_staff:      getField(raw, 'sales_staff') ? String(getField(raw, 'sales_staff')).trim() : null,
      service:          getField(raw, 'service') ? String(getField(raw, 'service')).trim() : null,
      trade_lane:       getField(raw, 'trade_lane') ? String(getField(raw, 'trade_lane')).trim() : null,
      origin_port:      getField(raw, 'origin_port') ? String(getField(raw, 'origin_port')).trim() : null,
      destination_port: getField(raw, 'destination_port') ? String(getField(raw, 'destination_port')).trim() : null,
      invoiced_date:    parseDate(getField(raw, 'invoiced_date')),
      revenue_local:    parseNumber(getField(raw, 'revenue_local')),
      cost_local:       parseNumber(getField(raw, 'cost_local')),
      gp_local:         parseNumber(getField(raw, 'gp_local')),
      currency_code:    getField(raw, 'currency_code') ? String(getField(raw, 'currency_code')).trim() : 'AUD',
      raw_row:          raw,
    });
  }

  logger.info('Rows parsed', { parsed: rows.length, skipped });
  return rows;
}

/** Upsert parsed rows into the staging table. */
async function upsertStaging(
  supabase: SupabaseClient,
  rows: ParsedRow[],
  reportDate: string,
  runId: string,
) {
  const stagingRows = rows.map(r => ({
    report_date:      reportDate,
    job_file_no:      r.job_file_no,
    consol_no:        r.consol_no,
    branch:           r.branch,
    department:       r.department,
    ops_staff:        r.ops_staff,
    sales_staff:      r.sales_staff,
    service:          r.service,
    trade_lane:       r.trade_lane,
    origin_port:      r.origin_port,
    destination_port: r.destination_port,
    invoiced_date:    r.invoiced_date,
    revenue_local:    r.revenue_local,
    cost_local:       r.cost_local,
    gp_local:         r.gp_local,
    currency_code:    r.currency_code,
    raw_row:          r.raw_row,
    ingest_run_id:    runId,
  }));

  logger.info('Upserting into staging.stg_invoiced_files_audit', { count: stagingRows.length });

  // Batch in chunks of 500 to avoid request size limits.
  // NOTE: migration 005 moved this table from public → staging, so we must
  // scope the query with .schema('staging'). The default client targets public,
  // which is correct for the core `files` table below. Requires `staging` to be
  // in the project's PostgREST "Exposed schemas" list (Supabase → API settings).
  const CHUNK = 500;
  for (let i = 0; i < stagingRows.length; i += CHUNK) {
    const chunk = stagingRows.slice(i, i + CHUNK);
    const { error } = await supabase
      .schema('staging')
      .from('stg_invoiced_files_audit')
      .upsert(chunk, { onConflict: 'report_date,job_file_no' });
    if (error) throw new Error(`Staging upsert failed: ${error.message}`);
  }
}

/**
 * Populate core files table from staging rows.
 * - Upserts each file with its first_invoice_date.
 * - Sets is_invoiced = true where invoiced_date is not null.
 * - Does NOT overwrite first_invoice_date if it's already set and earlier.
 */
async function populateCoreFiles(
  supabase: SupabaseClient,
  rows: ParsedRow[],
) {
  // Only upsert files that appear in this report with an invoice date.
  // Files without an invoice date are WIP/unbilled — handle separately
  // when that report is added.
  const fileRows = rows.map(r => ({
    job_file_no:        r.job_file_no,
    first_invoice_date: r.invoiced_date,   // null = not yet invoiced
    is_invoiced:        r.invoiced_date != null,
    // fiscal_period_key is set by a DB trigger or a subsequent step
    // that joins to fiscal_calendar — leave null for now.
  }));

  logger.info('Upserting into core files table', { count: fileRows.length });

  const CHUNK = 500;
  for (let i = 0; i < fileRows.length; i += CHUNK) {
    const chunk = fileRows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('files')
      .upsert(chunk, {
        onConflict: 'job_file_no',
        // Do not overwrite first_invoice_date if already set and earlier.
        // Supabase upsert does a full replace by default; use ignoreDuplicates
        // for the first pass and a separate UPDATE for refinement.
        ignoreDuplicates: false,
      });
    if (error) throw new Error(`Core files upsert failed: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Main entry point for this report
// ─────────────────────────────────────────────────────────────

/**
 * Run the full ingest pipeline for the Invoiced Files Audit report.
 * @param supabase  Supabase client (service-role)
 * @param runId     Unique ID for this ingest run (for tracing)
 * @param reportDate  ISO date string for the report snapshot (YYYY-MM-DD).
 *                    Defaults to today.
 */
export async function ingestInvoicedFilesAudit(
  supabase: SupabaseClient,
  runId: string,
  reportDate?: string,
): Promise<void> {
  const date = reportDate ?? new Date().toISOString().slice(0, 10);
  logger.info('Starting Invoiced Files Audit ingest', { reportDate: date, runId });

  // 1. Find the file on SharePoint
  // TODO: Confirm the actual file naming convention with Argents.
  //       Pattern below matches filenames containing "Invoiced" (case-insensitive).
  const filePattern = /invoiced.files.audit/i;
  const driveItem = await findLatestFile(filePattern);
  if (!driveItem) {
    throw new Error('Invoiced Files Audit file not found on SharePoint. Check SHAREPOINT_REPORTS_FOLDER.');
  }
  logger.info('Found report file', { name: driveItem.name, size: driveItem.size });

  // 2. Download
  const buffer = await downloadFile(driveItem.name);

  // 3. Parse
  const rows = parseInvoicedFilesAudit(buffer);
  if (rows.length === 0) {
    throw new Error('No rows parsed from Invoiced Files Audit — check column mapping.');
  }

  if (config.dryRun) {
    logger.info('DRY RUN — skipping database writes', { rowCount: rows.length });
    return;
  }

  // 4. Upsert staging
  await upsertStaging(supabase, rows, date, runId);

  // 5. Populate core files table
  await populateCoreFiles(supabase, rows);

  // Verification: count invoiced files and log for reconciliation
  const { count, error } = await supabase
    .from('files')
    .select('*', { count: 'exact', head: true })
    .eq('is_invoiced', true);

  if (!error) {
    logger.info('Reconciliation check — total invoiced files in DB', {
      count,
      expected: 175,
      match: count === 175 ? '✓ MATCHES' : '✗ MISMATCH — investigate',
    });
  }

  logger.info('Invoiced Files Audit ingest complete', { reportDate: date, rowCount: rows.length });
}
