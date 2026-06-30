-- =============================================================
-- Migration 004: Canonical definition views
--
-- These are the ONLY place where business metrics are defined.
-- Both dashboards query these views — never the underlying tables
-- directly for metric derivation.
--
-- Change a definition once here; everything downstream updates.
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- v_invoiced_files
-- The deduplication view: one row per invoiced file.
-- This is the "175" source — a file counts ONCE, at its first
-- AR invoice. Supplementary invoices do NOT re-count the file.
--
-- Locked definition (do not change without leadership sign-off):
--   COUNT(DISTINCT job_file_no) WHERE ≥1 posted AR invoice exists,
--   counted by first_invoice_date.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_invoiced_files AS
SELECT
  f.job_file_no,
  f.first_invoice_date,
  f.job_date,
  f.file_status,
  fc.fiscal_year,
  fc.fiscal_period,
  fc.period_name                          AS fiscal_period_name,
  fc.period_start                         AS fiscal_period_start,
  fc.period_end                           AS fiscal_period_end
FROM files f
JOIN fiscal_calendar fc
  ON fc.calendar_date = f.first_invoice_date
WHERE f.is_invoiced = TRUE
  -- Guard: must have at least one posted AR invoice
  AND EXISTS (
    SELECT 1
    FROM invoices i
    WHERE i.job_file_no = f.job_file_no
      AND i.is_posted   = TRUE
      AND i.is_credit   = FALSE  -- TODO: confirm credit treatment with Argents
  );

COMMENT ON VIEW v_invoiced_files IS
  'Canonical invoiced-file list. One row per file that has ≥1 posted AR invoice. '
  'Reconciliation anchor: total COUNT(*) must equal 175 (Invoiced Files Audit). '
  'Period assigned by first_invoice_date per locked definitions.';


-- ─────────────────────────────────────────────────────────────
-- v_invoiced_file_count_by_period
-- The primary count metric dashboards display.
-- Must return 175 total across all periods for the production period.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_invoiced_file_count_by_period AS
SELECT
  fiscal_year,
  fiscal_period,
  fiscal_period_name,
  fiscal_period_start,
  fiscal_period_end,
  COUNT(*)          AS invoiced_file_count
FROM v_invoiced_files
GROUP BY
  fiscal_year,
  fiscal_period,
  fiscal_period_name,
  fiscal_period_start,
  fiscal_period_end
ORDER BY
  fiscal_year,
  fiscal_period;

COMMENT ON VIEW v_invoiced_file_count_by_period IS
  'Invoiced file count grouped by 4-5-4 fiscal period. '
  'Dashboards use this for the primary shipment count KPI. '
  'Sum of invoiced_file_count across all periods for the production '
  'run must equal 175 (Invoiced Files Audit reconciliation anchor).';


-- ─────────────────────────────────────────────────────────────
-- v_gross_profit_posted (CANONICAL GP — P&L-tied)
-- Revenue and cost from POSTED lines only.
-- NEVER includes accruals or WIP — that is a separate view.
-- Locked definition: canonical GP = posted revenue minus posted costs.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_gross_profit_posted AS
SELECT
  f.job_file_no,
  f.first_invoice_date,
  fc.fiscal_year,
  fc.fiscal_period,
  fc.period_name                                  AS fiscal_period_name,

  -- Revenue: posted AR invoices only (initial + supplementary)
  COALESCE(SUM(i.revenue) FILTER (
    WHERE i.is_posted = TRUE AND i.is_credit = FALSE
  ), 0)                                           AS revenue_posted,

  -- Credit notes reduce revenue
  COALESCE(SUM(i.revenue) FILTER (
    WHERE i.is_posted = TRUE AND i.is_credit = TRUE
  ), 0)                                           AS revenue_credits,

  -- Net posted revenue
  COALESCE(SUM(i.revenue) FILTER (
    WHERE i.is_posted = TRUE AND i.is_credit = FALSE
  ), 0)
  - COALESCE(SUM(i.revenue) FILTER (
    WHERE i.is_posted = TRUE AND i.is_credit = TRUE
  ), 0)                                           AS net_revenue_posted,

  -- Posted actual costs only (excludes accrued/wip)
  COALESCE(SUM(c.amount) FILTER (
    WHERE c.cost_type = 'actual' AND c.is_posted = TRUE
  ), 0)                                           AS cost_posted,

  -- Canonical GP = net posted revenue minus posted costs
  (
    COALESCE(SUM(i.revenue) FILTER (
      WHERE i.is_posted = TRUE AND i.is_credit = FALSE
    ), 0)
    - COALESCE(SUM(i.revenue) FILTER (
      WHERE i.is_posted = TRUE AND i.is_credit = TRUE
    ), 0)
    - COALESCE(SUM(c.amount) FILTER (
      WHERE c.cost_type = 'actual' AND c.is_posted = TRUE
    ), 0)
  )                                               AS gross_profit_posted

FROM files f
JOIN fiscal_calendar fc ON fc.calendar_date = f.first_invoice_date
LEFT JOIN invoices i    ON i.job_file_no = f.job_file_no
LEFT JOIN costs c       ON c.job_file_no = f.job_file_no
WHERE f.is_invoiced = TRUE
GROUP BY
  f.job_file_no,
  f.first_invoice_date,
  fc.fiscal_year,
  fc.fiscal_period,
  fc.period_name;

COMMENT ON VIEW v_gross_profit_posted IS
  'CANONICAL GP — P&L-tied. Posted revenue minus posted actual costs. '
  'Accruals and WIP are EXCLUDED. Reconciliation anchor: totals must tie to the P&L. '
  'Do NOT use for projected or WIP reporting — use v_projected_gp_incl_accruals for that.';


-- ─────────────────────────────────────────────────────────────
-- v_projected_gp_incl_accruals  (LABELLED SEPARATELY — not canonical GP)
-- Includes accrued and WIP costs for forward-looking/operations view.
-- MUST be clearly labelled "Projected GP incl. accruals" everywhere
-- it appears in a dashboard — never presented as the P&L number.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_projected_gp_incl_accruals AS
SELECT
  f.job_file_no,
  f.first_invoice_date,
  fc.fiscal_year,
  fc.fiscal_period,
  fc.period_name                                  AS fiscal_period_name,

  -- Net posted revenue (same as canonical)
  COALESCE(SUM(i.revenue) FILTER (
    WHERE i.is_posted = TRUE AND i.is_credit = FALSE
  ), 0)
  - COALESCE(SUM(i.revenue) FILTER (
    WHERE i.is_posted = TRUE AND i.is_credit = TRUE
  ), 0)                                           AS net_revenue_posted,

  -- ALL cost types (actual + accrued + wip)
  COALESCE(SUM(c.amount), 0)                      AS cost_total_incl_accruals,

  -- Projected GP = posted revenue minus ALL costs
  (
    COALESCE(SUM(i.revenue) FILTER (
      WHERE i.is_posted = TRUE AND i.is_credit = FALSE
    ), 0)
    - COALESCE(SUM(i.revenue) FILTER (
      WHERE i.is_posted = TRUE AND i.is_credit = TRUE
    ), 0)
    - COALESCE(SUM(c.amount), 0)
  )                                               AS projected_gp_incl_accruals

FROM files f
JOIN fiscal_calendar fc ON fc.calendar_date = COALESCE(f.first_invoice_date, f.job_date)
LEFT JOIN invoices i    ON i.job_file_no = f.job_file_no
LEFT JOIN costs c       ON c.job_file_no = f.job_file_no
GROUP BY
  f.job_file_no,
  f.first_invoice_date,
  fc.fiscal_year,
  fc.fiscal_period,
  fc.period_name;

COMMENT ON VIEW v_projected_gp_incl_accruals IS
  'PROJECTED GP — includes accrued and WIP costs. NOT the P&L number. '
  'Must be labelled "Projected GP incl. accruals" everywhere it appears in a dashboard. '
  'Never blended with or presented alongside v_gross_profit_posted as if they are the same metric.';


-- ─────────────────────────────────────────────────────────────
-- v_post_invoice_activity
-- Supplementary invoices and late costs on already-invoiced files.
-- Used for the post-invoice activity tracker in dashboards.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_post_invoice_activity AS
SELECT
  f.job_file_no,
  f.first_invoice_date,
  fc.fiscal_year,
  fc.fiscal_period,

  -- Supplementary revenue (does not re-count the file)
  COALESCE(SUM(i.revenue) FILTER (
    WHERE i.invoice_type = 'supplementary' AND i.is_posted = TRUE
  ), 0)                                           AS supplementary_revenue,

  -- Late / post-invoice costs
  COALESCE(SUM(c.amount) FILTER (
    WHERE c.is_post_invoice = TRUE AND c.cost_type = 'actual' AND c.is_posted = TRUE
  ), 0)                                           AS late_cost_posted,

  -- Count of supplementary invoices
  COUNT(DISTINCT i.invoice_no) FILTER (
    WHERE i.invoice_type = 'supplementary' AND i.is_posted = TRUE
  )                                               AS supplementary_invoice_count

FROM files f
JOIN fiscal_calendar fc ON fc.calendar_date = f.first_invoice_date
LEFT JOIN invoices i ON i.job_file_no = f.job_file_no
LEFT JOIN costs c    ON c.job_file_no = f.job_file_no
WHERE f.is_invoiced = TRUE
GROUP BY
  f.job_file_no,
  f.first_invoice_date,
  fc.fiscal_year,
  fc.fiscal_period;

COMMENT ON VIEW v_post_invoice_activity IS
  'Supplementary invoices and late costs on already-invoiced files. '
  'Supplementary invoices add revenue on a file that is already counted — '
  'they do not increment invoiced_file_count. Late costs move margin after invoicing.';
