-- =============================================================
-- Migration 002: Core modeled tables
-- files, invoices, costs
--
-- This is the clean, deduplicated layer that resolves the
-- 175-vs-206 discrepancy. Every downstream metric queries here,
-- never raw staging tables or SharePoint files directly.
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- files
-- One row per distinct CargoWise job/shipment (job_file_no).
-- "Invoiced" status is derived from the invoices table — do NOT
-- store a boolean here that can drift.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  job_file_no           TEXT        PRIMARY KEY,

  -- Date the job was opened in CargoWise (pre-invoice period anchor)
  job_date              DATE,

  -- First AR invoice date — set when the first invoice is inserted.
  -- NULL means the file has not yet been invoiced.
  -- This date drives fiscal_period_key for invoiced files.
  first_invoice_date    DATE,

  -- FK into fiscal_calendar: the period this file is counted in.
  -- For invoiced files: first_invoice_date.
  -- For pre-invoice WIP: job_date.
  -- Computed and stored by the ingest job; views should re-derive
  -- from first_invoice_date for maximum correctness.
  fiscal_period_key     DATE REFERENCES fiscal_calendar(calendar_date),

  -- ── Open definition — confirm before finalising ──────────────
  -- File-status ladder. Agreed values TBD with Argents.
  -- Placeholder values shown; do not trust without confirmation.
  -- Options under discussion:
  --   'open'              - job exists, no invoice yet
  --   'partially_invoiced'- ≥1 invoice but file not closed
  --   'invoiced'          - fully invoiced (may still receive late costs)
  --   'closed'            - finalized; no further billing expected
  --   'unbilled'          - has activity but zero AR invoices (~31 files)
  -- TODO: Confirm exact status ladder and transition rules with Argents.
  file_status           TEXT,

  -- Whether the file has ≥1 posted AR invoice (materialized flag for
  -- query performance; kept in sync by the ingest job).
  is_invoiced           BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Ingest bookkeeping
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_files_first_invoice_date
  ON files (first_invoice_date)
  WHERE first_invoice_date IS NOT NULL;

CREATE INDEX idx_files_fiscal_period
  ON files (fiscal_period_key)
  WHERE fiscal_period_key IS NOT NULL;

CREATE INDEX idx_files_is_invoiced
  ON files (is_invoiced);

COMMENT ON TABLE files IS
  'One row per distinct CargoWise job file (job_file_no). '
  'This is the deduplication anchor: a file is counted ONCE regardless of '
  'how many invoices or cost lines it carries. '
  'Canonical invoiced-file count = COUNT(DISTINCT job_file_no WHERE is_invoiced).';

COMMENT ON COLUMN files.first_invoice_date IS
  'Date of the first posted AR invoice on this file. NULL = not yet invoiced. '
  'This is the fiscal-period anchor per the locked definitions.';

COMMENT ON COLUMN files.file_status IS
  'OPEN DEFINITION — confirm status ladder with Argents before relying on this. '
  'See inline comment in migration for options under discussion.';


-- ─────────────────────────────────────────────────────────────
-- invoices
-- One row per AR invoice document.
-- invoice_type distinguishes initial vs supplementary:
--   'initial'       - first AR invoice on the file (the one that makes
--                     the file count as "invoiced")
--   'supplementary' - subsequent invoice (e.g. duty after freight).
--                     Does NOT re-count the file; tracked as post-invoice
--                     activity only.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                BIGSERIAL   PRIMARY KEY,
  invoice_no        TEXT        NOT NULL UNIQUE,      -- AR document number from CargoWise
  job_file_no       TEXT        NOT NULL REFERENCES files(job_file_no) ON DELETE RESTRICT,
  invoice_date      DATE        NOT NULL,
  invoice_type      TEXT        NOT NULL CHECK (invoice_type IN ('initial', 'supplementary')),
  revenue           NUMERIC(15, 2),                   -- posted revenue only (P&L-tied)
  currency          TEXT        NOT NULL DEFAULT 'AUD',
  is_posted         BOOLEAN     NOT NULL DEFAULT TRUE, -- FALSE = not yet posted; excluded from canonical GP
  is_credit         BOOLEAN     NOT NULL DEFAULT FALSE,-- TRUE = credit note

  -- ── Open definition — confirm before finalising ──────────────
  -- TODO: If a file is fully credited to zero, does it still count
  -- as "invoiced"? Flagging via is_credit but counting logic TBD.

  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoices_job_file_no
  ON invoices (job_file_no);

CREATE INDEX idx_invoices_invoice_date
  ON invoices (invoice_date);

CREATE INDEX idx_invoices_type_posted
  ON invoices (invoice_type, is_posted);

COMMENT ON TABLE invoices IS
  'One row per AR invoice document. '
  'invoice_type=''initial'' is the event that makes a file count as invoiced. '
  'invoice_type=''supplementary'' adds revenue on an already-invoiced file but '
  'does not increment the invoiced-file count.';

COMMENT ON COLUMN invoices.revenue IS
  'Posted revenue only. Accruals/projected amounts are NEVER stored here; '
  'they live in costs (accrued type) and are surfaced via a clearly-labelled '
  'separate view (v_projected_gp_incl_accruals).';


-- ─────────────────────────────────────────────────────────────
-- costs
-- One row per cost line (actual posted and accrued/WIP).
-- cost_type drives which views include a line:
--   'actual'   - posted cost; included in canonical GP (P&L-tied)
--   'accrued'  - estimated/accrued; included ONLY in projected GP view,
--                never blended into canonical GP
--   'wip'      - work-in-progress; TODO: confirm exact scope with Argents
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS costs (
  id                BIGSERIAL   PRIMARY KEY,
  cost_line_id      TEXT        NOT NULL UNIQUE,   -- stable CargoWise cost line key
  job_file_no       TEXT        NOT NULL REFERENCES files(job_file_no) ON DELETE RESTRICT,
  cost_date         DATE        NOT NULL,
  cost_type         TEXT        NOT NULL CHECK (cost_type IN ('actual', 'accrued', 'wip')),
  amount            NUMERIC(15, 2)   NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'AUD',
  is_posted         BOOLEAN     NOT NULL DEFAULT TRUE,
  -- TRUE when the cost was added after the file's first invoice date
  is_post_invoice   BOOLEAN     NOT NULL DEFAULT FALSE,

  -- ── Open definition — confirm before finalising ──────────────
  -- TODO: Confirm exact boundary between 'wip' and 'accrued' with Argents.

  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_costs_job_file_no
  ON costs (job_file_no);

CREATE INDEX idx_costs_type_posted
  ON costs (cost_type, is_posted);

CREATE INDEX idx_costs_post_invoice
  ON costs (is_post_invoice);

COMMENT ON TABLE costs IS
  'One row per cost line. cost_type=''actual'' (posted) feeds canonical GP. '
  'cost_type=''accrued'' and ''wip'' feed the labelled projected GP view only — '
  'they are NEVER blended into canonical GP per the locked definitions.';

COMMENT ON COLUMN costs.is_post_invoice IS
  'TRUE when this cost was recorded after the file''s first_invoice_date. '
  'Used to surface late-cost / cost-true-up activity in dashboards.';
