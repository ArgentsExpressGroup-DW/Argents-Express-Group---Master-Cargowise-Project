-- =============================================================
-- Migration 012: rebuild_core() v2 — add file-grain department/branch
--
-- Additive: financial logic (invoices/costs) unchanged. department/branch are
-- sourced solely from stg_job_profit_detail (job_ref = files.job_file_no;
-- department populated on all rows). For files whose lines span >1 department,
-- department = the file's largest-revenue line and department_is_mixed = TRUE.
-- Files with no Job Profit Detail rows remain NULL (not guessed).
-- Idempotent (truncate + rebuild each call).
-- =============================================================

CREATE OR REPLACE FUNCTION public.rebuild_core(p_report_date date)
RETURNS TABLE (files_count int, invoices_count int, costs_count int, invoiced_files int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, staging
AS $$
BEGIN
  TRUNCATE costs, invoices, files RESTART IDENTITY CASCADE;

  -- 1) files
  INSERT INTO files (job_file_no, job_date)
  SELECT j.job_file_no, MIN(jo.job_opened) AS job_date
  FROM (
    SELECT DISTINCT job_ref     AS job_file_no FROM staging.stg_job_profit_detail WHERE report_date = p_report_date AND job_ref IS NOT NULL
    UNION SELECT DISTINCT shipment_id          FROM staging.stg_shipment_profile   WHERE report_date = p_report_date AND shipment_id IS NOT NULL
    UNION SELECT DISTINCT reference            FROM staging.stg_job_status_summary WHERE report_date = p_report_date AND reference IS NOT NULL
    UNION SELECT DISTINCT job_ref              FROM staging.stg_unbilled_shipments WHERE report_date = p_report_date AND job_ref IS NOT NULL
  ) j
  LEFT JOIN (
    SELECT shipment_id AS job, job_opened FROM staging.stg_shipment_profile   WHERE report_date = p_report_date
    UNION ALL SELECT reference AS job, job_opened FROM staging.stg_job_status_summary WHERE report_date = p_report_date
  ) jo ON jo.job = j.job_file_no
  GROUP BY j.job_file_no;

  -- 2) invoices (REV lines with invoice number)
  INSERT INTO invoices (invoice_no, job_file_no, invoice_date, invoice_type, revenue, is_posted, is_credit)
  WITH rev AS (
    SELECT invoice_number AS invoice_no, MIN(job_ref) AS job_file_no, MIN(posted) AS invoice_date, SUM(amount) AS revenue
    FROM staging.stg_job_profit_detail
    WHERE report_date = p_report_date AND line_type = 'REV'
      AND invoice_number IS NOT NULL AND job_ref IS NOT NULL AND posted IS NOT NULL
    GROUP BY invoice_number
  ),
  ranked AS (
    SELECT r.*, ROW_NUMBER() OVER (PARTITION BY job_file_no ORDER BY invoice_date, invoice_no) AS rn
    FROM rev r WHERE job_file_no IN (SELECT job_file_no FROM files)
  )
  SELECT invoice_no, job_file_no, invoice_date,
         CASE WHEN rn = 1 THEN 'initial' ELSE 'supplementary' END,
         revenue, TRUE, (revenue < 0)
  FROM ranked;

  -- 3) costs (CST/ACR/WIP)
  INSERT INTO costs (cost_line_id, job_file_no, cost_date, cost_type, amount, is_posted, is_post_invoice)
  SELECT p_report_date::text || '-' || line_no::text, job_ref, COALESCE(posted, p_report_date),
         CASE line_type WHEN 'CST' THEN 'actual' WHEN 'ACR' THEN 'accrued' WHEN 'WIP' THEN 'wip' END,
         amount, TRUE, FALSE
  FROM staging.stg_job_profit_detail
  WHERE report_date = p_report_date AND line_type IN ('CST','ACR','WIP')
    AND job_ref IS NOT NULL AND amount IS NOT NULL AND job_ref IN (SELECT job_file_no FROM files);

  -- 4) first_invoice_date / is_invoiced / file_status
  UPDATE files f SET first_invoice_date = sub.fid, is_invoiced = TRUE, file_status = 'invoiced'
  FROM (SELECT job_file_no, MIN(invoice_date) AS fid FROM invoices WHERE is_posted AND NOT is_credit GROUP BY job_file_no) sub
  WHERE f.job_file_no = sub.job_file_no;
  UPDATE files SET file_status = 'open' WHERE is_invoiced = FALSE;

  UPDATE files f SET fiscal_period_key = f.first_invoice_date
  WHERE f.first_invoice_date IS NOT NULL
    AND EXISTS (SELECT 1 FROM fiscal_calendar fc WHERE fc.calendar_date = f.first_invoice_date);

  -- 5) post-invoice (late) costs
  UPDATE costs c SET is_post_invoice = TRUE
  FROM files f WHERE c.job_file_no = f.job_file_no
    AND f.first_invoice_date IS NOT NULL AND c.cost_date > f.first_invoice_date;

  -- 6) department / branch from Job Profit Detail.
  --    Dominant = the file's largest-revenue line; mixed = lines span >1 dept.
  WITH dom AS (
    SELECT DISTINCT ON (job_ref) job_ref, department, branch
    FROM staging.stg_job_profit_detail
    WHERE report_date = p_report_date AND department IS NOT NULL
    ORDER BY job_ref, revenue DESC NULLS LAST, amount DESC NULLS LAST, line_no
  ),
  mix AS (
    SELECT job_ref, COUNT(DISTINCT department) AS nd
    FROM staging.stg_job_profit_detail
    WHERE report_date = p_report_date AND department IS NOT NULL
    GROUP BY job_ref
  )
  UPDATE files f
  SET department = dom.department, branch = dom.branch, department_is_mixed = (mix.nd > 1)
  FROM dom JOIN mix ON mix.job_ref = dom.job_ref
  WHERE f.job_file_no = dom.job_ref;

  RETURN QUERY
  SELECT (SELECT count(*)::int FROM files),
         (SELECT count(*)::int FROM invoices),
         (SELECT count(*)::int FROM costs),
         (SELECT count(*)::int FROM files WHERE is_invoiced);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebuild_core(date) TO service_role;
