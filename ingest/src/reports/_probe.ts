import type { SupabaseClient } from '@supabase/supabase-js';
import { findLatestFile, downloadFile } from '../graph.js';
import { logger } from '../logger.js';
import { readMatrix } from './_cargowise.js';

async function probe(label: string, pattern: RegExp): Promise<void> {
  const item = await findLatestFile(pattern);
  if (!item) { logger.info('PROBE not found', { label }); return; }
  const buf = await downloadFile(item.name);
  const m = readMatrix(buf);
  logger.info('PROBE ' + label, {
    name: item.name,
    totalRows: m.length,
    rows: m.slice(0, 12).map((r, i) => i + ': ' + (r ?? []).map(c => String(c ?? '')).join(' | ')),
  });
}

export async function ingestProbe(_s: SupabaseClient, _r: string, _d?: string): Promise<void> {
  await probe('shipment-profile', /Shipment Profile/i);
  await probe('job-profit-detail', /Job Profit - Detail/i);
}
