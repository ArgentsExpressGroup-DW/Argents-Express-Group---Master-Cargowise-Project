/**
 * reports/shipment-profile.ts
 *
 * Ingest handler for "HHH Shipment Profile Report" → staging.stg_shipment_profile.
 * One row per shipment. Header (row ~13) has 52 columns; we map the typed
 * subset defined in migration 005. Three "UQ" columns follow Weight, Volume,
 * and Chargeable respectively, so those are taken positionally.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { downloadFile, findLatestFile } from '../graph.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import {
  readMatrix, str, parseNumber, parseDate, findHeaderRow, colIndex,
  rawRowObject, upsertStaging,
} from './_cargowise.js';

const FILE_PATTERN = /Shipment Profile/i;

export function parseShipmentProfile(buffer: Buffer, reportDate: string): Record<string, unknown>[] {
  const m = readMatrix(buffer);

  const h = findHeaderRow(m, ['shipment id', 'direction', 'job profit']);
  if (h < 0) throw new Error('Shipment Profile: header row not found');
  const header = m[h];

  const weightIdx     = colIndex(header, c => c === 'weight');
  const volumeIdx     = colIndex(header, c => c === 'volume');
  const chargeableIdx = colIndex(header, c => c === 'chargeable');

  const idx = {
    shipment_id:              colIndex(header, c => c === 'shipment id'),
    direction:                colIndex(header, c => c === 'direction'),
    trans_mode:               colIndex(header, c => c === 'trans'),
    pack_mode:                colIndex(header, c => c === 'mode'),
    origin:                   colIndex(header, c => c === 'origin'),
    origin_country:           colIndex(header, c => c.includes('orig') && c.includes('ctry')),
    destination:              colIndex(header, c => c === 'destination'),
    destination_country:      colIndex(header, c => c.includes('dest') && c.includes('ctry')),
    load_port:                colIndex(header, c => c === 'load'),
    discharge_port:           colIndex(header, c => c === 'discharge'),
    consignor_name:           colIndex(header, c => c.includes('consignor')),
    consignee_name:           colIndex(header, c => c.includes('consignee')),
    controlling_agent:        colIndex(header, c => c.includes('controlling agent')),
    sending_agent:            colIndex(header, c => c.includes('sending agent')),
    receiving_agent:          colIndex(header, c => c.includes('receiving agent')),
    overseas_agent:           colIndex(header, c => c.includes('overseas agent')),
    carrier_name:             colIndex(header, c => c.includes('carrier')),
    local_client_name:        colIndex(header, c => c.includes('local client')),
    job_branch:               colIndex(header, c => c === 'job branch'),
    job_dept:                 colIndex(header, c => c === 'job dept'),
    job_sales_rep:            colIndex(header, c => c.includes('sales rep')),
    job_operator:             colIndex(header, c => c.includes('job operator')),
    job_status:               colIndex(header, c => c === 'job status'),
    job_opened:               colIndex(header, c => c === 'job opened'),
    incoterm:                 colIndex(header, c => c === 'incoterm'),
    added:                    colIndex(header, c => c === 'added'),
    weight:                   weightIdx,
    weight_uq:                weightIdx >= 0 ? weightIdx + 1 : -1,
    volume:                   volumeIdx,
    volume_uq:                volumeIdx >= 0 ? volumeIdx + 1 : -1,
    chargeable:               chargeableIdx,
    chargeable_uq:            chargeableIdx >= 0 ? chargeableIdx + 1 : -1,
    teu:                      colIndex(header, c => c === 'teu'),
    container_count:          colIndex(header, c => c.includes('container count')),
    revenue_recognition_date: colIndex(header, c => c.includes('revenue recognition')),
    recognized_revenue:       colIndex(header, c => c === 'recognized revenue'),
    recognized_wip:           colIndex(header, c => c === 'recognized wip'),
    total_recognized_income:  colIndex(header, c => c.includes('total recognized income')),
    recognized_cost:          colIndex(header, c => c === 'recognized cost'),
    recognized_accrual:       colIndex(header, c => c === 'recognized accrual'),
    total_recognized_expense: colIndex(header, c => c.includes('total recognized expense')),
    job_profit:               colIndex(header, c => c === 'job profit'),
  };
  if (idx.shipment_id < 0) throw new Error('Shipment Profile: Shipment ID column not found');

  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (let i = h + 1; i < m.length; i++) {
    const r = m[i] ?? [];
    const id = str(r[idx.shipment_id]);
    if (!id) { skipped++; continue; }
    if (/^(shipment id|grand total|total)\b/i.test(id)) { skipped++; continue; }

    rows.push({
      report_date:              reportDate,
      shipment_id:              id,
      direction:                str(r[idx.direction]),
      trans_mode:               str(r[idx.trans_mode]),
      pack_mode:                str(r[idx.pack_mode]),
      origin:                   str(r[idx.origin]),
      origin_country:           str(r[idx.origin_country]),
      destination:              str(r[idx.destination]),
      destination_country:      str(r[idx.destination_country]),
      load_port:                str(r[idx.load_port]),
      discharge_port:           str(r[idx.discharge_port]),
      consignor_name:           str(r[idx.consignor_name]),
      consignee_name:           str(r[idx.consignee_name]),
      controlling_agent:        str(r[idx.controlling_agent]),
      sending_agent:            str(r[idx.sending_agent]),
      receiving_agent:          str(r[idx.receiving_agent]),
      overseas_agent:           str(r[idx.overseas_agent]),
      carrier_name:             str(r[idx.carrier_name]),
      local_client_name:        str(r[idx.local_client_name]),
      job_branch:               str(r[idx.job_branch]),
      job_dept:                 str(r[idx.job_dept]),
      job_sales_rep:            str(r[idx.job_sales_rep]),
      job_operator:             str(r[idx.job_operator]),
      job_status:               str(r[idx.job_status]),
      job_opened:               parseDate(r[idx.job_opened]),
      incoterm:                 str(r[idx.incoterm]),
      added:                    parseDate(r[idx.added]),
      weight:                   parseNumber(r[idx.weight]),
      weight_uq:                idx.weight_uq >= 0 ? str(r[idx.weight_uq]) : null,
      volume:                   parseNumber(r[idx.volume]),
      volume_uq:                idx.volume_uq >= 0 ? str(r[idx.volume_uq]) : null,
      chargeable:               parseNumber(r[idx.chargeable]),
      chargeable_uq:            idx.chargeable_uq >= 0 ? str(r[idx.chargeable_uq]) : null,
      teu:                      parseNumber(r[idx.teu]),
      container_count:          parseNumber(r[idx.container_count]),
      revenue_recognition_date: parseDate(r[idx.revenue_recognition_date]),
      recognized_revenue:       parseNumber(r[idx.recognized_revenue]),
      recognized_wip:           parseNumber(r[idx.recognized_wip]),
      total_recognized_income:  parseNumber(r[idx.total_recognized_income]),
      recognized_cost:          parseNumber(r[idx.recognized_cost]),
      recognized_accrual:       parseNumber(r[idx.recognized_accrual]),
      total_recognized_expense: parseNumber(r[idx.total_recognized_expense]),
      job_profit:               parseNumber(r[idx.job_profit]),
      raw_row:                  rawRowObject(header, r),
    });
  }

  logger.info('Shipment Profile rows parsed', { parsed: rows.length, skipped });
  return rows;
}

export async function ingestShipmentProfile(
  supabase: SupabaseClient,
  runId: string,
  reportDate?: string,
): Promise<void> {
  const date = reportDate ?? new Date().toISOString().slice(0, 10);
  logger.info('Starting Shipment Profile ingest', { reportDate: date, runId });

  const item = await findLatestFile(FILE_PATTERN);
  if (!item) throw new Error('Shipment Profile file not found in reports folder.');
  logger.info('Found report file', { name: item.name, size: item.size });

  const buffer = await downloadFile(item.name);
  const rows = parseShipmentProfile(buffer, date);
  if (rows.length === 0) throw new Error('No Shipment Profile rows parsed — check column mapping.');

  if (config.dryRun) {
    logger.info('DRY RUN — skipping DB writes', { rowCount: rows.length, sample: rows.slice(0, 2) });
    return;
  }

  const stagingRows = rows.map(r => ({ ...r, ingest_run_id: runId }));
  await upsertStaging(supabase, 'stg_shipment_profile', stagingRows, 'report_date,shipment_id', logger);
  logger.info('Shipment Profile ingest complete', { reportDate: date, rowCount: rows.length });
}
