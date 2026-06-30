-- =============================================================
-- Migration 013: FK files.department -> departments.code
--
-- Added after validating that every populated files.department value exists
-- in departments.code (10/10 matched at time of writing). NULL is allowed.
-- If a future department code appears that is not yet in departments, add it
-- to departments first or this constraint (and the transform) will reject it.
-- =============================================================

ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_department_fkey;
ALTER TABLE public.files
  ADD CONSTRAINT files_department_fkey
  FOREIGN KEY (department) REFERENCES public.departments(code);
