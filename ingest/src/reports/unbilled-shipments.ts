/**
 * reports/unbilled-shipments.ts
 *
 * Ingest handler for "Argents Express Group Shipments with no REV Transactions"
 * (Accounting Job Headers with No REV Transactions) → staging.stg_unbilled_shipments.
 * One row per job file with zero posted AR revenue.
 *
 * Header layout (note: TWO "Ops" columns = code + name; "Trans" + "Mode" split):
 *   Job Ref | Opened | Ops | Ops | Local Client | Created | Trans | Mode |
 *   Origin | Dest. | ETD | ETA | Consignor | Consignee
 * The body is grouped by operator with "Job Operator: …" and
 * "Total Job Operator … Count: N" separator rows, which are skipped.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { downloadFile, findLatestFile } from '../graph.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import {
  readMatrix, norm, str, parseDate, findHeaderRow, colIndex,
  rawRowObject, upsertStaging,
} from './_cargowise.js';

const FILE_PATTERN = /Shipments with no/i;

export interface UnbilledRow {
  report_date: string;
  job_ref: string;
  opened: string | null;
  ops_code: string | null;
  ops_name: string | null;
  local_client: string | null;
  created: string | null;
  trans_mode: string | null;
  pack_mode: string | null;
  origin: string | null;
  destination: string | null;
  etd: string | null;
  eta: string | null;
  consignor: string | null;
  consignee: string | null;
  raw_row: Record<string, unknown>;
}

export function parseUnbilled(buffer: Buffer, reportDate: string): UnbilledRow[] {
  const m = readMatrix(buffer);
  {
    const wbD = XLSX.read(buffer, { type: 'buffer' });
    logger.info('DIAG sheets', { names: wbD.SheetNames });
    wbD.SheetNames.forEach((sn, si) => {
      const mm = XLSX.utils.sheet_to_json(wbD.Sheets[sn], { header: 1, defval: null, blankrows: false }) as unknown[][];
      let hdr = -1;
      for (let i = 0; i < mm.length; i++) {
        if ((mm[i] ?? []).some(c => /^[A-Z]{3,}\d{3,}$/.test(String(c ?? '')))) { hdr = i; break; }
      }
      logger.info('DIAG sheet ' + si, {
        name: sn, rows: mm.length, firstDataRow: hdr,
        around: mm.slice(Math.max(0, hdr - 2), hdr + 2).map(r => (r ?? []).map(c => String(c ?? '')).join(' | ')),
      });
    });
  }

  const h = findHeaderRow(m, ['job ref', 'local client', 'consignee']);
  if (h < 0) throw new Error('Unbilled: header row (Job Ref/Local Client/Consignee) not found');
  const header = m[h];

  // Two "Ops" columns → code then name.
  const opsIdxs: number[] = [];
  header.forEach((c, i) => { if (norm(c) === 'ops') opsIdxs.push(i); });

  const idx = {
    job_ref:      colIndex(header, c => c.includes('job ref')),
    opened:       colIndex(header, c => c === 'opened'),
    ops_code:     opsIdxs[0] ?? -1,
    ops_name:     opsIdxs[1] ?? -1,
    local_client: colIndex(header, c => c.includes('local client')),
    created:      colIndex(header, c => c === 'created'),
    trans_mode:   colIndex(header, c => c.includes('trans')),
    pack_mode:    colIndex(header, c => c === 'mode'),
    origin:       colIndex(header, c => c === 'origin'),
    destination:  colIndex(header, c => c.startsWith('dest')),
    etd:          colIndex(header, c => c === 'etd'),
    eta:          colIndex(header, c => c === 'eta'),
    consignor:    colIndex(header, c => c.includes('consignor')),
    consignee:    colIndex(header, c => c.includes('consignee')),
  };
  if (idx.job_ref < 0) throw new Error('Unbilled: Job Ref column not found');

  const rows: UnbilledRow[] = [];
  let skipped = 0;
  for (let i = h + 1; i < m.length; i++) {
    const r = m[i] ?? [];
    const ref = str(r[idx.job_ref]);
    if (!ref) { skipped++; continue; }
    // skip group separators and repeated headers
    if (/^(job operator|total|job ref)/i.test(ref) || /\bcount\b/i.test(ref)) { skipped++; continue; }

    rows.push({
      report_date:  reportDate,
      job_ref:      ref,
      opened:       parseDate(r[idx.opened]),
      ops_code:     idx.ops_code >= 0 ? str(r[idx.ops_code]) : null,
      ops_name:     idx.ops_name >= 0 ? str(r[idx.ops_name]) : null,
      local_client: str(r[idx.local_client]),
      created:      parseDate(r[idx.created]),
      trans_mode:   str(r[idx.trans_mode]),
      pack_mode:    str(r[idx.pack_mode]),
      origin:       str(r[idx.origin]),
      destination:  str(r[idx.destination]),
      etd:          parseDate(r[idx.etd]),
      eta:          parseDate(r[idx.eta]),
      consignor:    str(r[idx.consignor]),
      consignee:    str(r[idx.consignee]),
      raw_row:      rawRowObject(header, r),
    });
  }

  logger.info('Unbilled rows parsed', { parsed: rows.length, skipped });
  return rows;
}

export async function ingestUnbilledShipments(
  supabase: SupabaseClient,
  runId: string,
  reportDate?: string,
): Promise<void> {
  const date = reportDate ?? new Date().toISOString().slice(0, 10);
  logger.info('Starting Unbilled Shipments ingest', { reportDate: date, runId });

  const item = await findLatestFile(FILE_PATTERN);
  if (!item) throw new Error('Unbilled Shipments file not found in reports folder.');
  logger.info('Found report file', { name: item.name, size: item.size });

  const buffer = await downloadFile(item.name);
  const rows = parseUnbilled(buffer, date);
  if (rows.length === 0) throw new Error('No Unbilled rows parsed — check column mapping.');

  if (config.dryRun) {
    logger.info('DRY RUN — skipping DB writes', { rowCount: rows.length, sample: rows.slice(0, 3) });
    return;
  }

  const stagingRows = rows.map(r => ({ ...r, ingest_run_id: runId }));
  await upsertStaging(supabase, 'stg_unbilled_shipments', stagingRows, 'report_date,job_ref', logger);
  logger.info('Unbilled Shipments ingest complete', { reportDate: date, rowCount: rows.length });
}
