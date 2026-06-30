-- =============================================================
-- Migration 010: Correct currency to USD on core tables
--
-- Migration 002 created invoices.currency / costs.currency with DEFAULT 'AUD',
-- but Argents (HHH) operates in USD — every CargoWise report prints
-- "Local Currency: USD" and staging.stg_wip_accrued_costs.currency is USD.
-- rebuild_core() doesn't set currency explicitly, so rows inherited the
-- wrong 'AUD' default. The amounts were always correct USD values; only the
-- label was wrong. Fix the default and re-label existing rows.
-- =============================================================

ALTER TABLE public.invoices ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE public.costs    ALTER COLUMN currency SET DEFAULT 'USD';

UPDATE public.invoices SET currency = 'USD' WHERE currency IS DISTINCT FROM 'USD';
UPDATE public.costs    SET currency = 'USD' WHERE currency IS DISTINCT FROM 'USD';
