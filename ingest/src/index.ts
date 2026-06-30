import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { logger } from './logger.js';
import { ingestArAged } from './reports/ar-aged-outstanding.js';
import { ingestUnbilledShipments } from './reports/unbilled-shipments.js';
import { ingestJobProfitSummary } from './reports/job-profit-summary.js';
import { ingestJobStatusSummary } from './reports/job-status-summary.js';
import { ingestWipAccruedCosts } from './reports/wip-accrued-costs.js';
import { ingestShipmentProfile } from './reports/shipment-profile.js';
import { ingestJobProfitDetail } from './reports/job-profit-detail.js';
import { randomUUID } from 'crypto';

const REPORTS = [
  { name: 'ar-aged-outstanding', handler: ingestArAged },
  { name: 'unbilled-shipments',  handler: ingestUnbilledShipments },
  { name: 'job-profit-summary',  handler: ingestJobProfitSummary },
  { name: 'job-status-summary',  handler: ingestJobStatusSummary },
  { name: 'wip-accrued-costs',   handler: ingestWipAccruedCosts },
  { name: 'shipment-profile',    handler: ingestShipmentProfile },
  { name: 'job-profit-detail',   handler: ingestJobProfitDetail },
];

async function main() {
  const runId = randomUUID();
  const reportDate = parseReportDate();
  logger.info('Ingest job starting', { runId, reportDate, dryRun: config.dryRun, reports: REPORTS.map(r => r.name) });
  const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, { auth: { persistSession: false } });
  const results: Array<{ report: string; status: 'ok' | 'error'; error?: string }> = [];
  for (const { name, handler } of REPORTS) {
    try { logger.info(`Running report: ${name}`); await handler(supabase, runId, reportDate); results.push({ report: name, status: 'ok' }); }
    catch (err) { const message = err instanceof Error ? err.message : String(err); logger.error(`Report failed: ${name}`, { error: message }); results.push({ report: name, status: 'error', error: message }); }
  }
  const failed = results.filter(r => r.status === 'error');
  logger.info('Ingest job complete', { runId, results });
  if (failed.length > 0) { logger.error('One or more reports failed', { failed }); process.exit(1); }
}

function parseReportDate(): string {
  const flag = process.argv.indexOf('--date');
  if (flag !== -1 && process.argv[flag + 1]) {
    const d = process.argv[flag + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid --date format: "${d}". Expected YYYY-MM-DD.`);
    return d;
  }
  return new Date().toISOString().slice(0, 10);
}

main().catch(err => { logger.error('Unhandled error in ingest job', { error: err instanceof Error ? err.message : String(err) }); process.exit(1); });
