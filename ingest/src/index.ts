/**
 * index.ts — Ingest job entry point
 *
 * Runs all registered report ingest handlers in sequence.
 * To add a new report: import its handler and add it to REPORTS.
 *
 * Usage:
 *   npm run dev                      # run all reports (today's date)
 *   npm run dev -- --date 2024-05-01 # run for a specific date
 *   DRY_RUN=true npm run dev         # parse without writing to Supabase
 */

import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { logger } from './logger.js';
import { ingestArAged } from './reports/ar-aged-outstanding.js';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────
// Report registry — the 7 CargoWise daily reports in the
// "Cargowise Daily File Dumps" SharePoint folder.
// Handlers are added one at a time as each is built + validated.
// ─────────────────────────────────────────────────────────────
const REPORTS = [
  { name: 'ar-aged-outstanding', handler: ingestArAged },
  // TODO (build + validate iteratively):
  // { name: 'unbilled-shipments',  handler: ingestUnbilledShipments },
  // { name: 'job-profit-summary',  handler: ingestJobProfitSummary },
  // { name: 'job-status-summary',  handler: ingestJobStatusSummary },
  // { name: 'shipment-profile',    handler: ingestShipmentProfile },
  // { name: 'wip-accrued-costs',   handler: ingestWipAccruedCosts },
  // { name: 'job-profit-detail',   handler: ingestJobProfitDetail },
];

async function main() {
  const runId      = randomUUID();
  const reportDate = parseReportDate();

  logger.info('Ingest job starting', {
    runId,
    reportDate,
    dryRun: config.dryRun,
    reports: REPORTS.map(r => r.name),
  });

  const supabase = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    { auth: { persistSession: false } },
  );

  const results: Array<{ report: string; status: 'ok' | 'error'; error?: string }> = [];

  for (const { name, handler } of REPORTS) {
    try {
      logger.info(`Running report: ${name}`);
      await handler(supabase, runId, reportDate);
      results.push({ report: name, status: 'ok' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Report failed: ${name}`, { error: message });
      results.push({ report: name, status: 'error', error: message });
    }
  }

  const failed = results.filter(r => r.status === 'error');
  logger.info('Ingest job complete', { runId, results });

  if (failed.length > 0) {
    logger.error('One or more reports failed', { failed });
    process.exit(1);
  }
}

function parseReportDate(): string {
  const flag = process.argv.indexOf('--date');
  if (flag !== -1 && process.argv[flag + 1]) {
    const d = process.argv[flag + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error(`Invalid --