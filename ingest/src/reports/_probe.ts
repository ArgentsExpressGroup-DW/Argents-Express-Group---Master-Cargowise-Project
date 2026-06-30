import type { SupabaseClient } from '@supabase/supabase-js';
import { findLatestFile, downloadFile } from '../graph.js';
import { logger } from '../logger.js';
import { readMatrix } from './_cargowise.js';

export async function ingestProbe(_s: SupabaseClient, _r: string, _d?: string): Promise<void> {
  const item = await findLatestFile(/Job Profit - Detail/i);
  if (!item) { logger.info('PROBE jpd not found'); return; }
  const m = readMatrix(await downloadFile(item.name));
  let hi = 0, best = -1;
  for (let i = 0; i < Math.min(40, m.length); i++) {
    const n = (m[i] ?? []).filter(c => String(c ?? '').trim() !== '').length;
    if (n > best) { best = n; hi = i; }
  }
  logger.info('PROBE jpd rows', {
    headerRow: hi,
    rows: m.slice(hi, hi + 16).map((r, i) => (hi + i) + ': ' + (r ?? []).map(c => String(c ?? '')).join(' | ')),
  });
}
