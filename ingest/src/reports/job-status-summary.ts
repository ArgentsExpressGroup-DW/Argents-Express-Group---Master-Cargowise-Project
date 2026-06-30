/**
 * reports/job-status-summary.ts
 *
 * Ingest handler for "HHH Job Status Summary Report" → staging.stg_job_status_summary.
 * One row per job reference per report date.
 *
 * Header layout:
 *   Reference | Stat | Type | Dpt | Orig | Dest. | Consignor | Consignee |
 *   Local Client | ETD | ETA | Job Opened | Units | UQ | Goods Description
 * The body is grouped by section rows: "SHIPMENT JOB STATUS",
 * "BRANCH: <code>", "TRANSPORT MODE: <mode>" — these set branch/transport_mode
 * context for the data rows that follow and are not themselves data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { downloadFile, findLatestFile } from '../graph.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import {
  readMatrix, str, parseNumber, parseDate, findHeaderRow, colIndex,
  rawRowObject, upsertStaging,
} from './_cargowise.js';

const FILE_PATTERN = /Job Status Summary/i;

export interface JobStatusRow {
  report_date: string;
  reference: string;
  stat: string | null;
  job_type: string | null;
  department: string | null;
  origin: string | null;
  destination: string | null;
  consignor: string | null;
  consignee: string | null;
  local_client: string | null;
  etd: string | null;
  eta: string | null;
  job_opened: string | null;
  units: number | null;
  unit_qty: string | null;
  goods_description: string | null;
  branch: string | null;
  transport_mode: string | null;
  raw_row: Record<string, unknown>;
}

export function parseJobStatus(buffer: Buffer, reportDate: string): JobStatusRow[] {
  const m = readMatrix(buffer);

  const h = findHeaderRow(m, ['reference', 'stat', 'consignee']);
  if (h < 0) throw new Error('Job Status: header row not found');
  const header = m[h];

  const idx = {
    reference:    colIndex(header, c => c === 'reference'),
    stat:         colIndex(header, c => c === 'stat'),
    job_type:     colIndex(header, c => c === 'type'),
    department:   colIndex(header, c => c === 'dpt'),
    origin:       colIndex(header, c => c === 'orig'),
    destination:  colIndex(header, c => c.startsWith('dest')),
    consignor:    colIndex(header, c => c.includes('consignor')),
    consignee:    colIndex(header, c => c.includes('consignee')),
    local_client: colIndex(header, c => c.includes('local client')),
    etd:          colIndex(header, c => c === 'etd'),
    eta:          colIndex(header, c => c === 'eta'),
    job_opened:   colIndex(header, c => c.includes('job opened')),
    units:        colIndex(header, c => c === 'units'),
    unit_qty:     colIndex(header, c => c === 'uq'),
    goods:        colIndex(header, c => c.includes('goods')),
  };
  if (idx.reference < 0) throw new Error('Job Status: Reference column not found');

  const rows: JobStatusRow[] = [];
  let branch: string | null = null;
  let transport: string | null = null;
  let skipped = 0;

  for (let i = h + 1; i < m.length; i++) {
    const r = m[i] ?? [];
    const joined = r.map(c => String(c ?? '')).join(' ');

    const bm = joined.match(/branch:\s*([A-Za-z0-9]+)/i);
    const tm = joined.match(/transport mode:\s*([A-Za-z0-9]+)/i);
    if (tm) { transport = tm[1].toUpperCase(); skipped++; continue; }
    if (bm) { branch = bm[1].toUpperCase(); skipped++; continue; }

    const ref = str(r[idx.reference]);
    if (!ref) { skipped++; continue; }
    if (/^(reference|shipment job status|total)\b/i.test(ref) || /\bcount\b/i.test(ref)) { skipped++; continue; }

    rows.push({
      report_date:       reportDate,
      reference:         ref,
      stat:              str(r[idx.stat]),
      job_type:          str(r[idx.job_type]),
      department:        str(r[idx.department]),
      origin:            str(r[idx.origin]),
      destination:       str(r[idx.destination]),
      consignor:         str(r[idx.consignor]),
      consignee:         str(r[idx.consignee]),
      local_client:      str(r[idx.local_client]),
      etd:               parseDate(r[idx.etd]),
      eta:               parseDate(r[idx.eta]),
      job_opened:        parseDate(r[idx.job_opened]),
      units:             parseNumber(r[idx.units]),
      unit_qty:          str(r[idx.unit_qty]),
      goods_description: str(r[idx.goods]),
      branch,
      transport_mode:    transport,
      raw_row:           rawRowObject(header, r),
    });
  }

  logger.info('Job Status rows parsed', { parsed: rows.length, skipped });
  return rows;
}

export async function ingestJobStatusSummary(
  supabase: SupabaseClient,
  runId: string,
  reportDate?: string,
): Promise<void> {
  const date = reportDate ?? new Date().toISOString().slice(0, 10);
  logger.info('Starting Job Status Summary ingest', { reportDate: date, runId });

  const item = await findLatestFile(FILE_PATTERN);
  if (!item) throw new Error('Job Status Summary file not found in reports folder.');
  logger.info('Found report file', { name: item.name, size: item.size });

  const buffer = await downloadFile(item.name);
  const rows = parseJobStatus(buffer, date);
  if (rows.length === 0) throw new Error('No Job Status rows parsed — check column mapping.');

  if (config.dryRun) {
    logger.info('DRY RUN — skipping DB writes', { rowCount: rows.length, sample: rows.slice(0, 3) });
    return;
  }

  const stagingRows = rows.map(r => ({ ...r, ingest_run_id: runId }));
  await upsertStaging(supabase, 'stg_job_status_summary', stagingRows, 'report_date,reference', logger);
  logger.info('Job Status Summary ingest complete', { reportDate: date, rowCount: rows.length });
}
