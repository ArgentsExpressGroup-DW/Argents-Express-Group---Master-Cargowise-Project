-- =============================================================
-- Migration 001: fiscal_calendar reference table
-- Purpose: Maps every calendar date to its 4-5-4 fiscal period.
-- This is the authority for period assignment across all metrics.
-- =============================================================

CREATE TABLE IF NOT EXISTS fiscal_calendar (
  calendar_date   DATE        PRIMARY KEY,
  fiscal_year     INT         NOT NULL,  -- e.g. 2024
  fiscal_quarter  INT         NOT NULL CHECK (fiscal_quarter BETWEEN 1 AND 4),
  fiscal_period   INT         NOT NULL CHECK (fiscal_period BETWEEN 1 AND 13),
  fiscal_week     INT         NOT NULL,  -- week number within the fiscal year
  period_name     TEXT        NOT NULL,  -- e.g. 'FY2024-P01'
  period_start    DATE        NOT NULL,
  period_end      DATE        NOT NULL
);

-- Index for range queries (common for dashboard date filters)
CREATE INDEX idx_fiscal_calendar_year_period
  ON fiscal_calendar (fiscal_year, fiscal_period);

COMMENT ON TABLE fiscal_calendar IS
  'Reference table mapping every calendar date to its 4-5-4 fiscal period. '
  'Populate once from a pre-built 4-5-4 calendar and update annually. '
  'All fiscal-period assignments in core tables and views join here.';

COMMENT ON COLUMN fiscal_calendar.fiscal_period IS
  '1–13; the 4-5-4 pattern yields 13 periods per year.';
COMMENT ON COLUMN fiscal_calendar.period_name IS
  'Human-readable label, e.g. ''FY2024-P01''. Used in dashboard display.';
