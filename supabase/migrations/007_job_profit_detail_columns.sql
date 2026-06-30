-- =============================================================
-- Migration 007: Typed columns for stg_job_profit_detail
--
-- The Job Profit - Detail by Job report is charge-line detail grouped under
-- "Job: <ref> (<status>) (<local_ref>)" header rows. Each job has many charge
-- lines (Type WIP/CST/REV/ACR), so the original UNIQUE (report_date, job_ref)
-- from migration 005 (placeholder) is not unique. Replace it with a per-report
-- line_no key and add the typed columns the ingest handler populates.
-- =============================================================

ALTER TABLE staging.stg_job_profit_detail
  DROP CONSTRAINT IF EXISTS uq_stg_job_profit_detail_ref;

ALTER TABLE staging.stg_job_profit_detail
  ALTER COLUMN job_ref DROP NOT NULL;

ALTER TABLE staging.stg_job_profit_detail
  ADD COLUMN IF NOT EXISTS line_no        INT,
  ADD COLUMN IF NOT EXISTS job_status     TEXT,
  ADD COLUMN IF NOT EXISTS local_ref      TEXT,
  ADD COLUMN IF NOT EXISTS line_type      TEXT,           -- WIP / CST / REV / ACR
  ADD COLUMN IF NOT EXISTS charge_code    TEXT,
  ADD COLUMN IF NOT EXISTS posted         DATE,
  ADD COLUMN IF NOT EXISTS branch         TEXT,
  ADD COLUMN IF NOT EXISTS department     TEXT,
  ADD COLUMN IF NOT EXISTS organisation   TEXT,
  ADD COLUMN IF NOT EXISTS invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS amount         NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS revenue        NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS wip            NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS cost           NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS accrual        NUMERIC(15,2);

ALTER TABLE staging.stg_job_profit_detail
  ADD CONSTRAINT uq_stg_jpd_line UNIQUE (report_date, line_no);

CREATE INDEX IF NOT EXISTS idx_stg_jpd_job    ON staging.stg_job_profit_detail (job_ref);
CREATE INDEX IF NOT EXISTS idx_stg_jpd_charge ON staging.stg_job_profit_detail (charge_code);

COMMENT ON COLUMN staging.stg_job_profit_detail.line_no IS
  'Per-report row ordinal (1-based). Idempotency key with report_date — job_ref '
  'repeats across charge lines. line_type/charge breakdown: amount is the line '
  'value; revenue/wip/cost/accrual split it by category.';
