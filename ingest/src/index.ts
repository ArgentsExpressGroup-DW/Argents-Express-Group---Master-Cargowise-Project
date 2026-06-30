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
import { ingestInvoicedFilesAudit } from './reports/invoiced-files-audit.js';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────
// Report registry
// Add new report handlers here as the migration expands.
// ─────────────────────────────────────────────────────────────
const REPORTS = [
  {
    name: 'invoiced-files-audit',
    handler: ingestInvoicedFilesAudit,
  },
  // TODO: add next reports here, e.g.:
  // { name: 'ar-invoice-detail',     handler: ingestArInvoiceDetail },
  // { name: 'cost-detail',           handler: ingestCostDetail },
  // { name: 'wip-accruals',          handler: ingestWipAccruals },
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
      throw new Error(`Invalid --date format: "${d}". Expected YYYY-MM-DD.`);
    }
    return d;
  }
  return new Date().toISOString().slice(0, 10);
}

main().catch(err => {
  logger.error('Unhandled error in ingest job', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
