-- =============================================================
-- Migration 005: Staging schema + all CargoWise daily report tables
--
-- One raw-data table per CargoWise report. All follow the same pattern:
--   - Idempotency key: UNIQUE (report_date, <natural_key>)
--   - Typed columns for known fields (verified from actual files)
--   - raw_row JSONB — full xlsx row, never lost even if mapping changes
--   - RLS ON, no policies — service_role key only, never public/anon
--
-- Schema layout:
--   staging.*  — raw CargoWise data, server-side only
--   public.*   — core tables + canonical views (unchanged)
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- Create staging schema and lock it down
-- ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS staging;

-- Revoke all default public access to staging schema
REVOKE ALL ON SCHEMA staging FROM PUBLIC;

-- Move existing staging table into staging schema
ALTER TABLE public.stg_invoiced_files_audit SET SCHEMA staging;


-- ─────────────────────────────────────────────────────────────
-- 1. stg_ar_aged_outstanding
-- Source: AR Aged Outstanding Transactions – Summary
-- File pattern: AR Aged Outstanding Transactions - Summa (YYYY-MM-DD HH-MM-SS).XLSX
--
-- One row per client (org_code) per report date.
-- Aging buckets are fiscal-period-labeled (Current = report period,
-- 1 Period = 1 month prior, etc.).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staging.stg_ar_aged_outstanding (
  id                BIGSERIAL       PRIMARY KEY,

  report_date       DATE            NOT NULL,
  as_of_period      TEXT            NOT NULL,   -- fiscal period label, e.g. '202606'

  org_code          TEXT            NOT NULL,   -- CargoWise organisation code
  org_name          TEXT,

  -- Aging buckets (all in report currency — USD)
  total_amount      NUMERIC(15,2),
  current_amount    NUMERIC(15,2),   -- ≤ current period
  period_1          NUMERIC(15,2),   -- ≤ 1 period ago
  period_2          NUMERIC(15,2),   -- ≤ 2 periods ago
  period_3          NUMERIC(15,2),   -- ≤ 3 periods ago
  period_3_plus     NUMERIC(15,2),   -- 3+ periods overdue

  over_credit_limit BOOLEAN         NOT NULL DEFAULT FALSE,  -- '*' flag in report

  raw_row           JSONB           NOT NULL,
  ingested_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  ingest_run_id     TEXT,

  CONSTRAINT uq_stg_ar_aged_report_org UNIQUE (report_date, org_code)
);

CREATE INDEX idx_stg_ar_aged_date    ON staging.stg_ar_aged_outstanding (report_date);
CREATE INDEX idx_stg_ar_aged_org     ON staging.stg_ar_aged_outstanding (org_code);

ALTER TABLE staging.stg_ar_aged_outstanding ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE staging.stg_ar_aged_outstanding IS
  'Raw CargoWise AR Aged Outstanding Transactions – Summary. '
  'One row per client (org_code) per report date. '
  'Aging buckets: current + 4 prior periods. over_credit_limit flags clients marked * in the report.';


-- ─────────────────────────────────────────────────────────────
-- 2. stg_unbilled_shipments
-- Source: Argents Express Group Shipments with no REV Transactions (Unbilled)
-- File pattern: Argents Express Group Shipments with no (YYYY-MM-DD HH-MM-SS).XLSX
--
-- One row per job file with zero posted AR revenue.
-- These are the ~31 "unbilled" files referenced in the locked definitions.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staging.stg_unbilled_shipments (
  id                BIGSERIAL       PRIMARY KEY,

  report_date       DATE            NOT NULL,
  job_ref           TEXT            NOT NULL,   -- CargoWise job reference

  opened            DATE,                        -- job opened date
  ops_code          TEXT,                        -- operator code (e.g. AC)
  ops_name          TEXT,                        -- operator full name
  local_client      TEXT,                        -- client code
  created           DATE,
  trans_mode        TEXT,                        -- SEA, AIR, ROA, RAI
  pack_mode         TEXT,                        -- FCL, LCL, etc.
  origin            TEXT,                        -- UN/LOCODE
  destination       TEXT,                        -- UN/LOCODE
  etd               DATE,
  eta               DATE,
  consignor         TEXT,
  consignee         TEXT,

  raw_row           JSONB           NOT NULL,
  ingested_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  ingest_run_id     TEXT,

  CONSTRAINT uq_stg_unbilled_report_job UNIQUE (report_date, job_ref)
);

CREATE INDEX idx_stg_unbilled_date    ON staging.stg_unbilled_shipments (report_date);
CREATE INDEX idx_stg_unbilled_job_ref ON staging.stg_unbilled_shipments (job_ref);

ALTER TABLE staging.stg_unbilled_shipments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE staging.stg_unbilled_shipments IS
  'Raw CargoWise Shipments with no REV Transactions (Unbilled). '
  'One row per job file per report date. '
  'Key metric: COUNT(*) per report date should reconcile with the ~31 unbilled file count. '
  'Definition of "unbilled" (open TODO): no AR header vs no posted invoices — confirm with Argents.';


-- ─────────────────────────────────────────────────────────────
-- 3. stg_job_profit_summary
-- Source: HHH Job Profit Forwarding – Summary by Local Client
-- File pattern: HHH Job Profit Forwarding-Summary by Loc (YYYY-MM-DD HH-MM-SS).XLSX
--
-- One row per local client per report date.
-- Report covers a date range (period_from / period_to from header).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staging.stg_job_profit_summary (
  id                BIGSERIAL       PRIMARY KEY,

  report_date       DATE            NOT NULL,
  period_from       DATE,                        -- report date range start (from header)
  period_to         DATE,                        -- report date range end (from header)

  local_client      TEXT            NOT NULL,    -- client code
  local_client_name TEXT,

  -- Financial summary (all local currency)
  job_profit        NUMERIC(15,2),
  revenue           NUMERIC(15,2),
  wip               NUMERIC(15,2),
  cost              NUMERIC(15,2),
  accrual           NUMERIC(15,2),

  raw_row           JSONB           NOT NULL,
  ingested_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  ingest_run_id     TEXT,

  CONSTRAINT uq_stg_job_profit_summary_client UNIQUE (report_date, local_client)
);

CREATE INDEX idx_stg_profit_summary_date   ON staging.stg_job_profit_summary (report_date);
CREATE INDEX idx_stg_profit_summary_client ON staging.stg_job_profit_summary (local_client);

ALTER TABLE staging.stg_job_profit_summary ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE staging.stg_job_profit_summary IS
  'Raw CargoWise Job Profit Forwarding – Summary by Local Client. '
  'One row per local client per report date. '
  'period_from/period_to capture the report header date range. '
  'wip and accrual are NOT canonical GP — use v_gross_profit_posted for P&L-tied figures.';


-- ─────────────────────────────────────────────────────────────
-- 4. stg_job_status_summary
-- Source: HHH Job Status Summary Report
-- File pattern: HHH Job Status Summary Report Tuesday, 3 (YYYY-MM-DD HH-MM-SS).XLSX
--
-- One row per job reference per report date.
-- Grouped by branch and transport mode in the report; branch/transport
-- are captured per row for easy filtering.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staging.stg_job_status_summary (
  id                BIGSERIAL       PRIMARY KEY,

  report_date       DATE            NOT NULL,
  reference         TEXT            NOT NULL,    -- job reference (e.g. SCHSEA018271)

  stat              TEXT,                         -- status code, e.g. WRK
  job_type          TEXT,                         -- e.g. LSE
  department        TEXT,                         -- Dept code
  origin            TEXT,                         -- UN/LOCODE
  destination       TEXT,                         -- UN/LOCODE
  consignor         TEXT,
  consignee         TEXT,
  local_client      TEXT,
  etd               DATE,
  eta               DATE,
  job_opened        DATE,
  units             NUMERIC(10,2),
  unit_qty          TEXT,                         -- unit qualifier (UQ)
  goods_description TEXT,

  -- Grouping context from report layout
  branch            TEXT,                         -- e.g. CHS
  transport_mode    TEXT,                         -- e.g. AIR, SEA

  raw_row           JSONB           NOT NULL,
  ingested_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  ingest_run_id     TEXT,

  CONSTRAINT uq_stg_job_status_ref UNIQUE (report_date, reference)
);

CREATE INDEX idx_stg_job_status_date ON staging.stg_job_status_summary (report_date);
CREATE INDEX idx_stg_job_status_stat ON staging.stg_job_status_summary (stat);
CREATE INDEX idx_stg_job_status_ref  ON staging.stg_job_status_summary (reference);

ALTER TABLE staging.stg_job_status_summary ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE staging.stg_job_status_summary IS
  'Raw CargoWise Job Status Summary. One row per job reference per report date. '
  'branch and transport_mode are captured from the report grouping headers. '
  'stat=WRK indicates active/working jobs.';


-- ─────────────────────────────────────────────────────────────
-- 5. stg_shipment_profile
-- Source: HHH Shipment Profile Report
-- File pattern: HHH Shipment Profile Report Monday, 29 J (YYYY-MM-DD HH-MM-SS).XLSX
--
-- One row per shipment per report date. Richest report — 38+ columns
-- including full routing, financials, agents, and container details.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staging.stg_shipment_profile (
  id                        BIGSERIAL       PRIMARY KEY,

  report_date               DATE            NOT NULL,
  shipment_id               TEXT            NOT NULL,   -- CargoWise shipment reference

  -- Routing
  direction                 TEXT,            -- IMPORT / EXPORT
  trans_mode                TEXT,            -- SEA, AIR, ROA, RAI
  pack_mode                 TEXT,            -- FCL, LCL, etc.
  origin                    TEXT,            -- UN/LOCODE
  origin_country            TEXT,
  destination               TEXT,            -- UN/LOCODE
  destination_country       TEXT,
  load_port                 TEXT,
  discharge_port            TEXT,

  -- Parties
  consignor_name            TEXT,
  consignee_name            TEXT,
  controlling_agent         TEXT,
  sending_agent             TEXT,
  receiving_agent           TEXT,
  overseas_agent            TEXT,
  carrier_name              TEXT,

  -- Job metadata
  local_client_name         TEXT,
  job_branch                TEXT,
  job_dept                  TEXT,
  job_sales_rep             TEXT,
  job_operator              TEXT,
  job_status                TEXT,
  job_opened                DATE,
  incoterm                  TEXT,
  added                     DATE,

  -- Cargo dimensions
  weight                    NUMERIC(12,3),
  weight_uq                 TEXT,
  volume                    NUMERIC(12,3),
  volume_uq                 TEXT,
  chargeable                NUMERIC(12,3),
  chargeable_uq             TEXT,
  teu                       NUMERIC(8,2),
  container_count           INT,

  -- Financials (all local currency)
  revenue_recognition_date  DATE,
  recognized_revenue        NUMERIC(15,2),
  recognized_wip            NUMERIC(15,2),
  total_recognized_income   NUMERIC(15,2),  -- REV + WIP
  recognized_cost           NUMERIC(15,2),
  recognized_accrual        NUMERIC(15,2),
  total_recognized_expense  NUMERIC(15,2),  -- CST + ACR
  job_profit                NUMERIC(15,2),

  raw_row                   JSONB           NOT NULL,
  ingested_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  ingest_run_id             TEXT,

  CONSTRAINT uq_stg_shipment_profile UNIQUE (report_date, shipment_id)
);

CREATE INDEX idx_stg_shipment_profile_date   ON staging.stg_shipment_profile (report_date);
CREATE INDEX idx_stg_shipment_profile_id     ON staging.stg_shipment_profile (shipment_id);
CREATE INDEX idx_stg_shipment_profile_branch ON staging.stg_shipment_profile (job_branch);
CREATE INDEX idx_stg_shipment_profile_client ON staging.stg_shipment_profile (local_client_name);

ALTER TABLE staging.stg_shipment_profile ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE staging.stg_shipment_profile IS
  'Raw CargoWise Shipment Profile Report. One row per shipment per report date. '
  'Richest report — full routing, cargo dimensions, all parties, and job financials. '
  'recognized_wip and recognized_accrual are NOT canonical GP. '
  'job_profit here is CargoWise-calculated — verify alignment with v_gross_profit_posted.';


-- ─────────────────────────────────────────────────────────────
-- 6. stg_wip_accrued_costs
-- Source: HHH WIP Revenue and Accrued Costs Report
-- File pattern: HHH WIP Revenue and Accrued Costs Report (YYYY-MM-DD HH-MM-SS).XLSX
--
-- One row per cost/WIP line per job per report date.
-- Natural key: (report_date, job, local_ref) — local_ref is a
-- line-level identifier from CargoWise.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staging.stg_wip_accrued_costs (
  id                    BIGSERIAL       PRIMARY KEY,

  report_date           DATE            NOT NULL,
  job                   TEXT            NOT NULL,   -- job reference
  local_ref             TEXT            NOT NULL,   -- line-level key

  line_type             TEXT,            -- Type column (e.g. WIP, ACR)
  branch                TEXT,            -- Brn.
  department            TEXT,
  trans_mode            TEXT,
  container             TEXT,            -- Cont column
  charge_code           TEXT,
  stat                  TEXT,

  -- Financials (local currency)
  wip_amount            NUMERIC(15,2),
  accrual_amount        NUMERIC(15,2),
  currency              TEXT,

  -- Dates
  added                 DATE,
  job_opened            DATE,            -- Job Open column
  age_days              INT,             -- Age column

  -- Parties
  debtor_creditor       TEXT,
  controlling_agent     TEXT,
  controlling_customer  TEXT,

  -- Groupings
  expense_group         TEXT,            -- Exp Grp.
  group_code            TEXT,            -- Grp.
  sales_group           TEXT,            -- Sales Grp.

  -- Route
  etd                   DATE,
  origin                TEXT,
  eta                   DATE,
  destination           TEXT,

  raw_row               JSONB           NOT NULL,
  ingested_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  ingest_run_id         TEXT,

  CONSTRAINT uq_stg_wip_costs_job_ref UNIQUE (report_date, job, local_ref)
);

CREATE INDEX idx_stg_wip_date     ON staging.stg_wip_accrued_costs (report_date);
CREATE INDEX idx_stg_wip_job      ON staging.stg_wip_accrued_costs (job);
CREATE INDEX idx_stg_wip_type     ON staging.stg_wip_accrued_costs (line_type);

ALTER TABLE staging.stg_wip_accrued_costs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE staging.stg_wip_accrued_costs IS
  'Raw CargoWise WIP and Accrued Costs Report. One row per cost/WIP line per report date. '
  'Idempotency key: (report_date, job, local_ref). '
  'wip_amount feeds the WIP view; accrual_amount feeds projected GP — neither is canonical GP.';


-- ─────────────────────────────────────────────────────────────
-- 7. stg_job_profit_detail
-- Source: HHH Job Profit – Detail by Job
-- File pattern: HHH Job Profit - Detail by Job Tuesday, (YYYY-MM-DD HH-MM-SS).XLSX
--
-- PLACEHOLDER — 2.4MB file; Graph API cannot extract text inline.
-- Typed columns will be added once the ingest job reads the actual xlsx.
-- raw_row JSONB preserves everything in the meantime.
-- TODO: Inspect columns on first successful ingest run and add typed columns.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staging.stg_job_profit_detail (
  id                BIGSERIAL       PRIMARY KEY,

  report_date       DATE            NOT NULL,
  job_ref           TEXT            NOT NULL,   -- TODO: confirm natural key field name

  -- TODO: Add typed columns after inspecting real xlsx
  -- Expected fields (from report name/context):
  --   job_ref, local_client, branch, dept, trans_mode, job_profit,
  --   revenue, cost, wip, accrual, charge_code lines, etc.

  raw_row           JSONB           NOT NULL,
  ingested_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  ingest_run_id     TEXT,

  CONSTRAINT uq_stg_job_profit_detail_ref UNIQUE (report_date, job_ref)
);

CREATE INDEX idx_stg_profit_detail_date ON staging.stg_job_profit_detail (report_date);
CREATE INDEX idx_stg_profit_detail_ref  ON staging.stg_job_profit_detail (job_ref);

ALTER TABLE staging.stg_job_profit_detail ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE staging.stg_job_profit_detail IS
  'PLACEHOLDER — HHH Job Profit Detail by Job. '
  'Typed columns TBD after first ingest run inspects the xlsx headers. '
  'raw_row captures all data so nothing is lost during the placeholder period. '
  'TODO: Add typed columns and update COLUMN_MAP in ingest/src/reports/job-profit-detail.ts.';
