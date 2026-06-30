-- =============================================================
-- Migration 006: Fix stg_wip_accrued_costs idempotency key
--
-- The WIP & Accrued Costs Detail report has MANY charge lines per
-- (job, local_ref) — local_ref is the job's accounting number, not a
-- line-level id. So the original UNIQUE (report_date, job, local_ref)
-- from migration 005 is not unique and would reject/collapse rows.
--
-- Fix: add a per-report line_no and key on (report_date, line_no).
-- The ingest handler assigns line_no by row order within each report.
-- =============================================================

ALTER TABLE staging.stg_wip_accrued_costs
  ADD COLUMN IF NOT EXISTS line_no INT;

ALTER TABLE staging.stg_wip_accrued_costs
  DROP CONSTRAINT IF EXISTS uq_stg_wip_costs_job_ref;

-- De-dupe guard before adding the new key (in case rows already exist).
-- (No-op on an empty table.)
ALTER TABLE staging.stg_wip_accrued_costs
  ADD CONSTRAINT uq_stg_wip_line UNIQUE (report_date, line_no);

COMMENT ON COLUMN staging.stg_wip_accrued_costs.line_no IS
  'Per-report row ordinal (1-based). Idempotency key with report_date, because '
  '(job, local_ref) repeats across charge lines.';
