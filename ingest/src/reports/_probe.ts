import type { SupabaseClient } from '@supabase/supabase-js';
import { findLatestFile, downloadFile } from '../graph.js';
import { logger } from '../logger.js';
import { readMatrix } from './_cargowise.js';

async function probe(label: string, pattern: RegExp): Promise<void> {
  const item = await findLatestFile(pattern);
  if (!item) { logger.info('PROBE not found', { label }); return; }
  const buf = await downloadFile(item.name);
  const m = readMatrix(buf);
  // header = the row in the first 40 with the most non-empty cells
  let hi = 0, best = -1;
  for (let i = 0; i < Math.min(40, m.length); i++) {
    const n = (m[i] ?? []).filter(c => String(c ?? '').trim() !== '').length;
    if (n > best) { best = n; hi = i; }
  }
  logger.info('PROBE ' + label, {
    name: item.name, totalRows: m.length, headerRow: hi,
    header: (m[hi] ?? []).map(c => String(c ?? '')).filter(x => x.trim() !== ''),
    sample1: (m[hi + 1] ?? []).map(c => String(c ?? '')),
    sample2: (m[hi + 2] ?? []).map(c => String(c ?? '')),
  });
}

export async function ingestProbe(_s: SupabaseClient, _r: string, _d?: string): Promise<void> {
  await probe('shipment-profile', /Shipment Profile/i);
  await probe('job-profit-detail', /Job Profit - Detail/i);
}
