-- =============================================================
-- Migration 008: rebuild_core() — staging → core transform
--
-- Rebuilds the canonical core tables (files / invoices / costs) from the
-- line-level staging report (stg_job_profit_detail) for a given report_date,
-- plus job metadata from the other staging reports.
--
-- Idempotent: truncates and rebuilds core each call, so re-running a
-- report_date is safe. Called by the ingest job after staging upserts.
--
-- Documented business defaults (confirmed with David 2026-06-30; adjustable):
--   * Source of invoices/costs = stg_job_profit_detail charge lines.
--   * REV lines with an invoice number  -> invoices (revenue = sum per invoice).
--     - earliest invoice per file = 'initial' (counts the file), rest 'supplementary'
--     - negative net revenue on an invoice = credit note (is_credit = true)
--     - all shown lines treated as posted (the report excludes reversed WIP/ACR)
--   * CST -> costs.actual, ACR -> costs.accrued, WIP -> costs.wip
--   * first_invoice_date = MIN(invoice_date) of posted, non-credit invoices
--   * is_post_invoice = cost_date later than the file's first_invoice_date
--   * The "175" Invoiced Files Audit anchor is intentionally NOT enforced here.
-- =============================================================

CREATE OR REPLACE FUNCTION public.rebuild_core(p_report_date date)
RETURNS TABLE (files_count int, invoices_count int, costs_count int, invoiced_files int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, staging
AS $$
BEGIN
  -- Clear core (children first via CASCADE on the parent).
  TRUNCATE costs, invoices, files RESTART IDENTITY CASCADE;

  -- 1) files: every distinct job seen across the staging reports for this date.
  INSERT INTO files (job_file_no, job_date)
  SELECT j.job_file_no, MIN(jo.job_opened) AS job_date
  FROM (
    SELECT DISTINCT job_ref     AS job_file_no FROM staging.stg_job_profit_detail WHERE report_date = p_report_date AND job_ref IS NOT NULL
    UNION
    SELECT DISTINCT shipment_id                 FROM staging.stg_shipment_profile   WHERE report_date = p_report_date AND shipment_id IS NOT NULL
    UNION
    SELECT DISTINCT reference                   FROM staging.stg_job_status_summary WHERE report_date = p_report_date AND reference IS NOT NULL
    UNION
    SELECT DISTINCT job_ref                     FROM staging.stg_unbilled_shipments WHERE report_date = p_report_date AND job_ref IS NOT NULL
  ) j
  LEFT JOIN (
    SELECT shipment_id AS job, job_opened FROM staging.stg_shipment_profile   WHERE report_date = p_report_date
    UNION ALL
    SELECT reference   AS job, job_opened FROM staging.stg_job_status_summary WHERE report_date = p_report_date
  ) jo ON jo.job = j.job_file_no
  GROUP BY j.job_file_no;

  -- 2) invoices: REV lines that carry an invoice number, aggregated per invoice.
  INSERT INTO invoices (invoice_no, job_file_no, invoice_date, invoice_type, revenue, is_posted, is_credit)
  WITH rev AS (
    SELECT invoice_number          AS invoice_no,
           MIN(job_ref)            AS job_file_no,   -- an invoice belongs to one job
           MIN(posted)             AS invoice_date,
           SUM(amount)             AS revenue
    FROM staging.stg_job_profit_detail
    WHERE report_date = p_report_date
      AND line_type = 'REV'
      AND invoice_number IS NOT NULL
      AND job_ref        IS NOT NULL
      AND posted         IS NOT NULL
    GROUP BY invoice_number
  ),
  ranked AS (
    SELECT r.*,
           ROW_NUMBER() OVER (PARTITION BY job_file_no ORDER BY invoice_date, invoice_no) AS rn
    FROM rev r
    WHERE job_file_no IN (SELECT job_file_no FROM files)
  )
  SELECT invoice_no, job_file_no, invoice_date,
         CASE WHEN rn = 1 THEN 'initial' ELSE 'supplementary' END,
         revenue, TRUE, (revenue < 0)
  FROM ranked;

  -- 3) costs: CST/ACR/WIP lines. cost_line_id = report_date + per-report line_no.
  INSERT INTO costs (cost_line_id, job_file_no, cost_date, cost_type, amount, is_posted, is_post_invoice)
  SELECT p_report_date::text || '-' || line_no::text,
         job_ref,
         COALESCE(posted, p_report_date),
         CASE line_type WHEN 'CST' THEN 'actual' WHEN 'ACR' THEN 'accrued' WHEN 'WIP' THEN 'wip' END,
         amount,
         TRUE,
         FALSE
  FROM staging.stg_job_profit_detail
  WHERE report_date = p_report_date
    AND line_type IN ('CST', 'ACR', 'WIP')
    AND job_ref IS NOT NULL
    AND amount  IS NOT NULL
    AND job_ref IN (SELECT job_file_no FROM files);

  -- 4) derive first_invoice_date / is_invoiced / file_status.
  UPDATE files f
  SET first_invoice_date = sub.fid,
      is_invoiced        = TRUE,
      file_status        = 'invoiced'
  FROM (
    SELECT job_file_no, MIN(invoice_date) AS fid
    FROM invoices
    WHERE is_posted = TRUE AND is_credit = FALSE
    GROUP BY job_file_no
  ) sub
  WHERE f.job_file_no = sub.job_file_no;

  UPDATE files SET file_status = 'open' WHERE is_invoiced = FALSE;

  -- fiscal_period_key: only set when the date exists in fiscal_calendar (FK).
  UPDATE files f
  SET fiscal_period_key = f.first_invoice_date
  WHERE f.first_invoice_date IS NOT NULL
    AND EXISTS (SELECT 1 FROM fiscal_calendar fc WHERE fc.calendar_date = f.first_invoice_date);

  -- 5) flag post-invoice (late) costs.
  UPDATE costs c
  SET is_post_invoice = TRUE
  FROM files f
  WHERE c.job_file_no = f.job_file_no
    AND f.first_invoice_date IS NOT NULL
    AND c.cost_date > f.first_invoice_date;

  RETURN QUERY
  SELECT (SELECT count(*)::int FROM files),
         (SELECT count(*)::int FROM invoices),
         (SELECT count(*)::int FROM costs),
         (SELECT count(*)::int FROM files WHERE is_invoiced);
END;
$$;

-- Let the ingest job (service_role key) invoke the transform via PostgREST RPC.
GRANT EXECUTE ON FUNCTION public.rebuild_core(date) TO service_role;
