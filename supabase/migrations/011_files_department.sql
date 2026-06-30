-- =============================================================
-- Migration 011: file-grain department / branch attributes on public.files
--
-- Additive and nullable. Does not touch existing financial columns. RLS intact.
-- Populated by rebuild_core() from staging.stg_job_profit_detail.
-- FK to departments.code added in migration 013 (after value reconciliation).
-- =============================================================

ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS department          TEXT,
  ADD COLUMN IF NOT EXISTS branch              TEXT,
  ADD COLUMN IF NOT EXISTS department_is_mixed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_files_department ON public.files (department);

COMMENT ON COLUMN public.files.department IS
  'File-grain department (departments.code). From Job Profit Detail; for files '
  'whose lines span >1 department this is the largest-revenue line and '
  'department_is_mixed = TRUE. NULL when the file has no Job Profit Detail rows.';
