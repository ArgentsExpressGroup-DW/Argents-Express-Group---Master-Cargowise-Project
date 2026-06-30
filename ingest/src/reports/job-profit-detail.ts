/**
 * reports/job-profit-detail.ts
 *
 * Ingest handler for "HHH Job Profit - Detail by Job" → staging.stg_job_profit_detail.
 * Charge-line detail grouped under "Job: <ref> (<status>) (<local_ref>)" rows.
 *
 * Header (row ~27): Type | Charge | Posted | Br | Dep | Organisation |
 *   Invoice Number | Amount | Job Profit | Revenue | WIP | Cost | Accrual
 * Each "Job:" row sets context; the following rows with a Type (WIP/CST/REV/ACR)
 * and Charge code are the lines we emit. Meta rows ("Branch:…", "Details:…")
 * and the per-job total line (no Type) are skipped. One row per charge line,
 * keyed by (report_date, line_no). See migration 007.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { downloadFile, findLatestFile } from '../graph.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import {
  readMatrix, norm, str, parseNumber, parseDate, findHeaderRow, colIndex,
  rawRowObject, upsertStaging,
} from './_cargowise.js';

const FILE_PATTERN = /Job Profit - Detail/i;
const LINE_TYPES = new Set(['wip', 'cst', 'rev', 'acr']);

export function parseJobProfitDetail(buffer: Buffer, reportDate: string): Record<string, unknown>[] {
  const m = readMatrix(buffer);

  const h = findHeaderRow(m, ['type', 'charge', 'amount']);
  if (h < 0) throw new Error('Job Profit Detail: header row not found');
  const header = m[h];

  const idx = {
    line_type:   colIndex(header, c => c === 'type'),
    charge_code: colIndex(header, c => c === 'charge'),
    posted:      colIndex(header, c => c === 'posted'),
    branch:      colIndex(header, c => c === 'br'),
    department:  colIndex(header, c => c === 'dep'),
    org:         colIndex(header, c => c === 'organisation'),
    invoice:     colIndex(header, c => c.includes('invoice')),
    amount:      colIndex(header, c => c === 'amount'),
    revenue:     colIndex(header, c => c === 'revenue'),
    wip:         colIndex(header, c => c === 'wip'),
    cost:        colIndex(header, c => c === 'cost'),
    accrual:     colIndex(header, c => c === 'accrual'),
  };
  if (idx.line_type < 0 || idx.charge_code < 0) {
    throw new Error('Job Profit Detail: Type/Charge columns not found');
  }

  const rows: Record<string, unknown>[] = [];
  let jobRef: string | null = null;
  let jobStatus: string | null = null;
  let localRef: string | null = null;
  let lineNo = 0;
  let skipped = 0;

  const jobRe = /Job:\s*(\S+)\s*\(([^)]*)\)\s*\(([^)]*)\)/;

  for (let i = h + 1; i < m.length; i++) {
    const r = m[i] ?? [];
    const joined = r.map(c => String(c ?? '')).join(' ');

    const jm = joined.match(jobRe);
    if (jm) { jobRef = jm[1]; jobStatus = jm[2].trim() || null; localRef = jm[3].trim() || null; skipped++; continue; }

    const type = norm(r[idx.line_type]);
    const charge = str(r[idx.charge_code]);
    // Only emit real charge lines: a recognised Type + a charge code.
    if (!LINE_TYPES.has(type) || !charge) { skipped++; continue; }

    lineNo += 1;
    rows.push({
      report_date:    reportDate,
      line_no:        lineNo,
      job_ref:        jobRef,
      job_status:     jobStatus,
      local_ref:      localRef,
      line_type:      String(r[idx.line_type]).trim().toUpperCase(),
      charge_code:    charge,
      posted:         parseDate(r[idx.posted]),
      branch:         str(r[idx.branch]),
      department:     str(r[idx.department]),
      organisation:   str(r[idx.org]),
      invoice_number: str(r[idx.invoice]),
      amount:         parseNumber(r[idx.amount]),
      revenue:        parseNumber(r[idx.revenue]),
      wip:            parseNumber(r[idx.wip]),
      cost:           parseNumber(r[idx.cost]),
      accrual:        parseNumber(r[idx.accrual]),
      raw_row:        rawRowObject(header, r),
    });
  }

  logger.info('Job Profit Detail rows parsed', { parsed: rows.length, skipped });
  return rows;
}

export async function ingestJobProfitDetail(
  supabase: SupabaseClient,
  runId: string,
  reportDate?: string,
): Promise<void> {
  const date = reportDate ?? new Date().toISOString().slice(0, 10);
  logger.info('Starting Job Profit Detail ingest', { reportDate: date, runId });

  const item = await findLatestFile(FILE_PATTERN);
  if (!item) throw new Error('Job Profit Detail file not found in reports folder.');
  logger.info('Found report file', { name: item.name, size: item.size });

  const buffer = await downloadFile(item.name);
  const rows = parseJobProfitDetail(buffer, date);
  if (rows.length === 0) throw new Error('No Job Profit Detail rows parsed — check column mapping.');

  if (config.dryRun) {
    logger.info('DRY RUN — skipping DB writes', { rowCount: rows.length, sample: rows.slice(0, 3) });
    return;
  }

  const stagingRows = rows.map(r => ({ ...r, ingest_run_id: runId }));
  await upsertStaging(supabase, 'stg_job_profit_detail', stagingRows, 'report_date,line_no', logger);
  logger.info('Job Profit Detail ingest complete', { reportDate: date, rowCount: rows.length });
}
