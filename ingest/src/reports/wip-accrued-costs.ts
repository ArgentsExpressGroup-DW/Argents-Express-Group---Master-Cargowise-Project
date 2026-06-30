/**
 * reports/wip-accrued-costs.ts
 *
 * Ingest handler for "HHH WIP Revenue and Accrued Costs Report (Detail)"
 * → staging.stg_wip_accrued_costs. One row per cost/WIP line.
 *
 * Header layout:
 *   Type | Brn. | Dept | Trans | Cont | Charge Code | Job | Local Ref | Stat |
 *   WIP | Accrual | Currency | Added | Job Open | Age | Debtor/Creditor |
 *   Controlling Agent | Controlling Customer | Exp Grp. | Grp. | Sales Grp. |
 *   ETD | Orig | ETA | Dest.
 *
 * NOTE: a single (job, local_ref) has MANY charge lines, so the natural
 * (report_date, job, local_ref) key is not unique. We assign a per-report
 * line_no and upsert on (report_date, line_no). See migration 006.
 * wip_amount feeds WIP; accrual_amount feeds projected GP — neither is canonical GP.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { downloadFile, findLatestFile } from '../graph.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import {
  readMatrix, str, parseNumber, parseDate, findHeaderRow, colIndex,
  rawRowObject, upsertStaging,
} from './_cargowise.js';

const FILE_PATTERN = /WIP Revenue and Accrued/i;

export interface WipRow {
  report_date: string;
  line_no: number;
  line_type: string | null;
  branch: string | null;
  department: string | null;
  trans_mode: string | null;
  container: string | null;
  charge_code: string | null;
  job: string | null;
  local_ref: string | null;
  stat: string | null;
  wip_amount: number | null;
  accrual_amount: number | null;
  currency: string | null;
  added: string | null;
  job_opened: string | null;
  age_days: number | null;
  debtor_creditor: string | null;
  controlling_agent: string | null;
  controlling_customer: string | null;
  expense_group: string | null;
  group_code: string | null;
  sales_group: string | null;
  etd: string | null;
  origin: string | null;
  eta: string | null;
  destination: string | null;
  raw_row: Record<string, unknown>;
}

export function parseWip(buffer: Buffer, reportDate: string): WipRow[] {
  const m = readMatrix(buffer);

  const h = findHeaderRow(m, ['charge code', 'job', 'local ref']);
  if (h < 0) throw new Error('WIP: header row not found');
  const header = m[h];

  const idx = {
    line_type:   colIndex(header, c => c === 'type'),
    branch:      colIndex(header, c => c.startsWith('brn')),
    department:  colIndex(header, c => c === 'dept'),
    trans_mode:  colIndex(header, c => c === 'trans'),
    container:   colIndex(header, c => c === 'cont'),
    charge_code: colIndex(header, c => c.includes('charge code')),
    job:         colIndex(header, c => c === 'job'),
    local_ref:   colIndex(header, c => c.includes('local ref')),
    stat:        colIndex(header, c => c === 'stat'),
    wip:         colIndex(header, c => c === 'wip'),
    accrual:     colIndex(header, c => c === 'accrual'),
    currency:    colIndex(header, c => c === 'currency'),
    added:       colIndex(header, c => c === 'added'),
    job_open:    colIndex(header, c => c.includes('job open')),
    age:         colIndex(header, c => c === 'age'),
    debtor:      colIndex(header, c => c.includes('debtor')),
    ctrl_agent:  colIndex(header, c => c.includes('agent')),
    ctrl_cust:   colIndex(header, c => c.includes('customer')),
    exp_grp:     colIndex(header, c => c.includes('exp grp')),
    grp:         colIndex(header, c => c === 'grp.'),
    sales_grp:   colIndex(header, c => c.includes('sales grp')),
    etd:         colIndex(header, c => c === 'etd'),
    origin:      colIndex(header, c => c === 'orig'),
    eta:         colIndex(header, c => c === 'eta'),
    destination: colIndex(header, c => c.startsWith('dest')),
  };
  if (idx.job < 0) throw new Error('WIP: Job column not found');

  const rows: WipRow[] = [];
  let lineNo = 0;
  let skipped = 0;
  for (let i = h + 1; i < m.length; i++) {
    const r = m[i] ?? [];
    const job = str(r[idx.job]);
    if (!job) { skipped++; continue; }
    if (/grand total|^total\b/i.test(job)) break;
    if (/^job$/i.test(job)) continue;

    lineNo += 1;
    rows.push({
      report_date:          reportDate,
      line_no:              lineNo,
      line_type:            str(r[idx.line_type]),
      branch:               str(r[idx.branch]),
      department:           str(r[idx.department]),
      trans_mode:           str(r[idx.trans_mode]),
      container:            str(r[idx.container]),
      charge_code:          str(r[idx.charge_code]),
      job,
      local_ref:            str(r[idx.local_ref]),
      stat:                 str(r[idx.stat]),
      wip_amount:           parseNumber(r[idx.wip]),
      accrual_amount:       parseNumber(r[idx.accrual]),
      currency:             str(r[idx.currency]),
      added:                parseDate(r[idx.added]),
      job_opened:           parseDate(r[idx.job_open]),
      age_days:             parseNumber(r[idx.age]),
      debtor_creditor:      str(r[idx.debtor]),
      controlling_agent:    idx.ctrl_agent >= 0 ? str(r[idx.ctrl_agent]) : null,
      controlling_customer: idx.ctrl_cust >= 0 ? str(r[idx.ctrl_cust]) : null,
      expense_group:        str(r[idx.exp_grp]),
      group_code:           str(r[idx.grp]),
      sales_group:          str(r[idx.sales_grp]),
      etd:                  parseDate(r[idx.etd]),
      origin:               str(r[idx.origin]),
      eta:                  parseDate(r[idx.eta]),
      destination:          str(r[idx.destination]),
      raw_row:              rawRowObject(header, r),
    });
  }

  logger.info('WIP rows parsed', { parsed: rows.length, skipped });
  return rows;
}

export async function ingestWipAccruedCosts(
  supabase: SupabaseClient,
  runId: string,
  reportDate?: string,
): Promise<void> {
  const date = reportDate ?? new Date().toISOString().slice(0, 10);
  logger.info('Starting WIP & Accrued Costs ingest', { reportDate: date, runId });

  const item = await findLatestFile(FILE_PATTERN);
  if (!item) throw new Error('WIP & Accrued Costs file not found in reports folder.');
  logger.info('Found report file', { name: item.name, size: item.size });

  const buffer = await downloadFile(item.name);
  const rows = parseWip(buffer, date);
  if (rows.length === 0) throw new Error('No WIP rows parsed — check column mapping.');

  if (config.dryRun) {
    logger.info('DRY RUN — skipping DB writes', { rowCount: rows.length, sample: rows.slice(0, 3) });
    return;
  }

  const stagingRows = rows.map(r => ({ ...r, ingest_run_id: runId }));
  await upsertStaging(supabase, 'stg_wip_accrued_costs', stagingRows, 'report_date,line_no', logger);
  logger.info('WIP & Accrued Costs ingest complete', { reportDate: date, rowCount: rows.length });
}
