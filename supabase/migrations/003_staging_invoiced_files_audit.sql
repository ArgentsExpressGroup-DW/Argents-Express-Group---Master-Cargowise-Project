-- =============================================================
-- Migration 003: Staging table — Invoiced Files Audit report
--
-- One row per (report_date, job_file_no) exactly as exported by
-- CargoWise. The ingest job upserts here first (idempotent).
-- The transform step then populates files/invoices/costs from this.
--
-- Column names below are best-guess from the project brief.
-- TODO: Verify exact column names against the real CargoWise xlsx
-- before relying on typed columns. The raw_row JSONB column captures
-- the full row so nothing is lost if the schema needs adjustment.
-- =============================================================

CREATE TABLE IF NOT EXISTS stg_invoiced_files_audit (
  id                    BIGSERIAL       PRIMARY KEY,

  -- Idempotency key: one row per report snapshot date + file number.
  -- Re-running the ingest job for the same date is safe.
  report_date           DATE            NOT NULL,
  job_file_no           TEXT            NOT NULL,

  -- ── Typed columns (verify against real file before relying on these) ──
  -- TODO: Pull a real export and confirm column names exactly.
  consol_no             TEXT,           -- Consolidation/master bill number
  branch                TEXT,           -- Branch code
  department            TEXT,           -- Department code
  ops_staff             TEXT,           -- Operations staff / handler
  sales_staff           TEXT,           -- Sales rep
  service               TEXT,           -- Service type (e.g. AIR EXP, SEA FCL)
  trade_lane            TEXT,           -- Trade lane (e.g. IMPORT, EXPORT)
  origin_port           TEXT,
  destination_port      TEXT,
  invoiced_date         DATE,           -- Date of first AR invoice (CargoWise field)
  revenue_local         NUMERIC(15, 2), -- Total posted revenue, local currency
  cost_local            NUMERIC(15, 2), -- Total posted cost, local currency
  gp_local              NUMERIC(15, 2), -- GP as reported in the audit (revenue - cost)
  currency_code         TEXT,           -- e.g. 'AUD'

  -- Full raw row stored as JSONB — ensures no data is lost
  -- if column mapping evolves or new columns appear.
  raw_row               JSONB           NOT NULL,

  -- Ingest bookkeeping
  ingested_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  ingest_run_id         TEXT,           -- Unique ID per ingest run (for debugging)

  CONSTRAINT uq_stg_invoiced_files_audit
    UNIQUE (report_date, job_file_no)
);

CREATE INDEX idx_stg_ifa_report_date
  ON stg_invoiced_files_audit (report_date);

CREATE INDEX idx_stg_ifa_job_file_no
  ON stg_invoiced_files_audit (job_file_no);

COMMENT ON TABLE stg_invoiced_files_audit IS
  'Staging table for the CargoWise Invoiced Files Audit export. '
  'One row per (report_date, job_file_no). Ingest is idempotent: '
  're-running for the same date safely upserts without duplication. '
  'raw_row captures the full xlsx row for reprocessing if definitions change. '
  'Typed columns are best-guess — verify against real file before use.';

COMMENT ON COLUMN stg_invoiced_files_audit.raw_row IS
  'Full xlsx row as key:value JSONB. This is the reprocessing source — '
  'if a typed column mapping turns out to be wrong, fix the transform '
  'and re-derive from raw_row without re-downloading files from SharePoint.';
