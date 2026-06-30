/**
 * reports/job-profit-summary.ts
 *
 * Ingest handler for "HHH Job Profit Forwarding – Summary by Local Client"
 * → staging.stg_job_profit_summary. One row per local client per report date.
 *
 * Header layout:
 *   Local Client | Local Client Name | Job Profit | Revenue | WIP | Cost | Accrual
 * Title row carries "Transactions Recognized: From: 05-Jan-26 To: 30-Jun-26"
 * → period_from / period_to.
 *
 * NOTE: wip/accrual here are NOT canonical GP — see v_gross_profit_posted.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { downloadFile, findLatestFile } from '../graph.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import {
  readMatrix, str, parseNumber, parseDate, findHeaderRow, colIndex,
  rawRowObject, upsertStaging,
} from './_cargowise.js';

const FILE_PATTERN = /Job Profit Forwarding/i;

export interface JobProfitSummaryRow {
  report_date: string;
  period_from: string | null;
  period_to: string | null;
  local_client: string;
  local_client_name: string | null;
  job_profit: number | null;
  revenue: number | null;
  wip: number | null;
  cost: number | null;
  accrual: number | null;
  raw_row: Record<string, unknown>;
}

export function parseJobProfitSummary(buffer: Buffer, reportDate: string): JobProfitSummaryRow[] {
  const m = readMatrix(buffer);

  // Date range from a title row: "Transactions Recognized: From: <d> To: <d>"
  let periodFrom: string | null = null;
  let periodTo: string | null = null;
  for (let i = 0; i < Math.min(12, m.length); i++) {
    const line = (m[i] ?? []).map(c => String(c ?? '')).join(' ');
    const mt = line.match(/recognized:\s*from:\s*([0-9]{1,2}-[A-Za-z]{3}-[0-9]{2,4})\s*to:\s*([0-9]{1,2}-[A-Za-z]{3}-[0-9]{2,4})/i);
    if (mt) { periodFrom = parseDate(mt[1]); periodTo = parseDate(mt[2]); break; }
  }

  const h = findHeaderRow(m, ['local client', 'job profit', 'revenue']);
  if (h < 0) throw new Error('Job Profit Summary: header row not found');
  const header = m[h];

  const idx = {
    local_client:      colIndex(header, c => c === 'local client'),
    local_client_name: colIndex(header, c => c.includes('local client name')),
    job_profit:        colIndex(header, c => c.includes('job profit')),
    revenue:           colIndex(header, c => c === 'revenue'),
    wip:               colIndex(header, c => c === 'wip'),
    cost:              colIndex(header, c => c === 'cost'),
    accrual:           colIndex(header, c => c === 'accrual'),
  };
  if (idx.local_client < 0) throw new Error('Job Profit Summary: Local Client column not found');

  const rows: JobProfitSummaryRow[] = [];
  let skipped = 0;
  for (let i = h + 1; i < m.length; i++) {
    const r = m[i] ?? [];
    const client = str(r[idx.local_client]);
    if (!client) { skipped++; continue; }
    if (/grand total|^total\b/i.test(client)) break;
    if (/^local client$/i.test(client)) continue;

    rows.push({
      report_date:       reportDate,
      period_from:       periodFrom,
      period_to:         periodTo,
      local_client:      client,
      local_client_name: str(r[idx.local_client_name]),
      job_profit:        parseNumber(r[idx.job_profit]),
      revenue:           parseNumber(r[idx.revenue]),
      wip:               parseNumber(r[idx.wip]),
      cost:              parseNumber(r[idx.cost]),
      accrual:           parseNumber(r[idx.accrual]),
      raw_row:           rawRowObject(header, r),
    });
  }

  logger.info('Job Profit Summary rows parsed', { parsed: rows.length, skipped, periodFrom, periodTo });
  return rows;
}

export async function ingestJobProfitSummary(
  supabase: SupabaseClient,
  runId: string,
  reportDate?: string,
): Promise<void> {
  const date = reportDate ?? new Date().toISOString().slice(0, 10);
  logger.info('Starting Job Profit Summary ingest', { reportDate: date, runId });

  const item = await findLatestFile(FILE_PATTERN);
  if (!item) throw new Error('Job Profit Forwarding Summary file not found in reports folder.');
  logger.info('Found report file', { name: item.name, size: item.size });

  const buffer = await downloadFile(item.name);
  const rows = parseJobProfitSummary(buffer, date);
  if (rows.length === 0) throw new Error('No Job Profit Summary rows parsed — check column mapping.');

  if (config.dryRun) {
    logger.info('DRY RUN — skipping DB writes', { rowCount: rows.length, sample: rows.slice(0, 3) });
    return;
  }

  const stagingRows = rows.map(r => ({ ...r, ingest_run_id: runId }));
  await upsertStaging(supabase, 'stg_job_profit_summary', stagingRows, 'report_date,local_client', logger);
  logger.info('Job Profit Summary ingest complete', { reportDate: date, rowCount: rows.length });
}
