/**
 * reports/ar-aged-outstanding.ts
 *
 * Ingest handler for "AR Aged Outstanding Transactions – Summary".
 * One row per client (org_code) per report date → staging.stg_ar_aged_outstanding.
 *
 * Layout (header row, after several title rows):
 *   Org. Code | Org. Name | Total | Current | 1 Period | 2 Period | 3 Period | 3+ Period
 * Title row carries "... as at 202606" (the as_of_period). A trailing "*"
 * on a row marks the client as over credit limit.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { downloadFile, findLatestFile } from '../graph.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import {
  readMatrix, norm, str, parseNumber, findHeaderRow, colIndex,
  rawRowObject, periodFromDate, hasStarFlag, upsertStaging,
} from './_cargowise.js';

const FILE_PATTERN = /AR Aged Outstanding/i;

export interface ArAgedRow {
  report_date: string;
  as_of_period: string;
  org_code: string;
  org_name: string | null;
  total_amount: number | null;
  current_amount: number | null;
  period_1: number | null;
  period_2: number | null;
  period_3: number | null;
  period_3_plus: number | null;
  over_credit_limit: boolean;
  raw_row: Record<string, unknown>;
}

export function parseArAged(buffer: Buffer, reportDate: string): ArAgedRow[] {
  const m = readMatrix(buffer);

  // as_of_period from a title row, e.g. "... as at 202606"
  let asOf: string | null = null;
  for (let i = 0; i < Math.min(10, m.length); i++) {
    const line = (m[i] ?? []).map(c => String(c ?? '')).join(' ');
    const mt = line.match(/as at\s*(\d{6})/i);
    if (mt) { asOf = mt[1]; break; }
  }

  const h = findHeaderRow(m, ['org', 'total', 'current']);
  if (h < 0) throw new Error('AR Aged: header row (Org./Total/Current) not found');
  const header = m[h];

  const idx = {
    org_code: colIndex(header, c => c.includes('org') && c.includes('code')),
    org_name: colIndex(header, c => c.includes('org') && c.includes('name')),
    total:    colIndex(header, c => c === 'total'),
    current:  colIndex(header, c => c === 'current'),
    p1:       colIndex(header, c => c.includes('1 period')),
    p2:       colIndex(header, c => c.includes('2 period')),
    p3plus:   colIndex(header, c => c.includes('3+ period') || c.includes('3+period')),
    p3:       colIndex(header, c => c.includes('3 period')),
  };
  if (idx.org_code < 0) throw new Error('AR Aged: Org. Code column not found');

  const rows: ArAgedRow[] = [];
  let skipped = 0;
  for (let i = h + 1; i < m.length; i++) {
    const r = m[i] ?? [];
    const code = str(r[idx.org_code]);
    if (!code) { skipped++; continue; }
    if (/grand total/i.test(code)) break;            // totals row → end of data
    if (/^-?\d[\d.,]*%$/.test(code)) continue;        // percentage footer row
    if (norm(code) === norm(header[idx.org_code])) continue; // repeated header

    rows.push({
      report_date:       reportDate,
      as_of_period:      asOf ?? periodFromDate(reportDate),
      org_code:          code,
      org_name:          str(r[idx.org_name]),
      total_amount:      parseNumber(r[idx.total]),
      current_amount:    parseNumber(r[idx.current]),
      period_1:          parseNumber(r[idx.p1]),
      period_2:          parseNumber(r[idx.p2]),
      period_3:          parseNumber(r[idx.p3]),
      period_3_plus:     parseNumber(r[idx.p3plus]),
      over_credit_limit: hasStarFlag(r),
      raw_row:           rawRowObject(header, r),
    });
  }

  logger.info('AR Aged rows parsed', { parsed: rows.length, skipped, asOfPeriod: asOf });
  return rows;
}

export async function ingestArAged(
  supabase: SupabaseClient,
  runId: string,
  reportDate?: string,
): Promise<void> {
  const date = reportDate ?? new Date().toISOString().slice(0, 10);
  logger.info('Starting AR Aged Outstanding ingest', { reportDate: date, runId });

  const item = await findLatestFile(FILE_PATTERN);
  if (!item) throw new Error('AR Aged Outstanding file not found in reports folder.');
  logger.info('Found report file', { name: item.name, size: item.size });

  const buffer = await downloadFile(item.name);
  const rows = parseArAged(buffer, date);
  if (rows.length === 0) throw new Error('No AR Aged rows parsed — check column mapping.');

  if (config.dryRun) {
    logger.info('DRY RUN — skipping DB writes', {
      rowCount: rows.length,
      sample: rows.slice(0, 3),
    });
    return;
  }

  const stagingRows = rows.map(r => ({ ...r, ingest_run_id: runId }));
  await upsertStaging(supabase, 'stg_ar_aged_outstanding', stagingRows, 'report_date,org_code', logger);
  logger.info('AR Aged Outstanding ingest complete', { reportDate: date, rowCount: rows.length });
}
