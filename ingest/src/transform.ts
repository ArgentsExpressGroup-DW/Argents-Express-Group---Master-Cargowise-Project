/**
 * transform.ts — staging → core
 *
 * Calls the public.rebuild_core(report_date) SQL function (migration 008),
 * which rebuilds files/invoices/costs from the staging snapshot, then logs
 * the resulting row counts for observability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

export async function rebuildCore(supabase: SupabaseClient, reportDate: string): Promise<void> {
  logger.info('Rebuilding core tables from staging', { reportDate });
  const { data, error } = await supabase.rpc('rebuild_core', { p_report_date: reportDate });
  if (error) throw new Error(`rebuild_core failed: ${error.message}`);
  const counts = Array.isArray(data) ? data[0] : data;
  logger.info('Core rebuild complete', { counts });
}
