# Argents Express — Supabase Consolidation: Project State
*Last updated: 2026-06-30*

---

## What This Project Is

Replacing two separate, diverging Supabase databases (Argents Intelligence + Management Dashboard) with a single canonical source of truth. Both dashboards — and all future tools — will query this one database instead of re-parsing the same CargoWise files independently.

**Root cause of the existing problem:** Both dashboards independently parse the same CargoWise xlsx exports, applying slightly different logic. This causes reconciliation drift — e.g., the invoiced file count showing 206 in one dashboard vs 175 in the other. The 175 is correct (distinct job files with ≥1 posted AR invoice). The 206 is wrong (it was counting invoices, not files).

**Architecture fix:** One ingest job → one Supabase project → both dashboards read from canonical views.

---

## Supabase Project

| Field | Value |
|---|---|
| Project name | Argents Express Group - Master Cargowise Project |
| Project ID | `omnllhmiwbnajosvhchx` |
| Region | US East (Ohio) — kept as-is despite initial intent for Sydney |
| Dashboard URL | https://supabase.com/dashboard/project/omnllhmiwbnajosvhchx |
| SQL Editor | https://supabase.com/dashboard/project/omnllhmiwbnajosvhchx/sql/new |

---

## Data Flow

```
CargoWise (operational system)
    ↓  automated export (scheduled in CargoWise)
FTP
    ↓
SharePoint — "Cargowise Daily File Dumps" folder
    (argentsexpress.sharepoint.com/sites/DashboardsReports/
     Shared Documents/Administration/Supabase Migration Project/
     Cargowise Daily File Dumps)
    ↓  GitHub Actions (daily cron, time TBD)
Supabase staging.* tables  ← raw data, never touched by dashboards
    ↓  transform step (ingest job)
Supabase public.* core tables (files, invoices, costs, fiscal_calendar)
    ↓
Supabase public.v_* views  ← the ONLY thing dashboards query
    ↓
Dashboard A (Argents Intelligence)
Dashboard B (Management Dashboard)
Future tools
```

---

## Schema Layout

### `staging` schema — raw CargoWise data, server-side only
RLS ON, no policies. Reachable only via service_role key. Never queried by dashboards.

| Table | Source file | Idempotency key | Status |
|---|---|---|---|
| `stg_invoiced_files_audit` | Invoiced Files Audit (separate folder) | `(report_date, job_file_no)` | ✅ Done |
| `stg_ar_aged_outstanding` | AR Aged Outstanding Transactions - Summa | `(report_date, org_code)` | ✅ Done |
| `stg_unbilled_shipments` | Argents Express Group Shipments with no | `(report_date, job_ref)` | ✅ Done |
| `stg_job_profit_summary` | HHH Job Profit Forwarding-Summary by Loc | `(report_date, local_client)` | ✅ Done |
| `stg_job_status_summary` | HHH Job Status Summary Report | `(report_date, reference)` | ✅ Done |
| `stg_shipment_profile` | HHH Shipment Profile Report | `(report_date, shipment_id)` | ✅ Done |
| `stg_wip_accrued_costs` | HHH WIP Revenue and Accrued Costs Report | `(report_date, job, local_ref)` | ✅ Done |
| `stg_job_profit_detail` | HHH Job Profit - Detail by Job | `(report_date, job_ref)` | ⚠️ Placeholder — columns TBD after first ingest |

### `public` schema — core tables + canonical views

| Object | Type | Status |
|---|---|---|
| `fiscal_calendar` | Table | ✅ Done + populated FY2025 + FY2026 |
| `files` | Table | ✅ Done |
| `invoices` | Table | ✅ Done |
| `costs` | Table | ✅ Done |
| `v_invoiced_files` | View | ✅ Done |
| `v_invoiced_file_count_by_period` | View | ✅ Done |
| `v_gross_profit_posted` | View | ✅ Done |
| `v_projected_gp_incl_accruals` | View | ✅ Done |
| `v_post_invoice_activity` | View | ✅ Done |

---

## Migrations Applied (in order)

| File | Description | Status |
|---|---|---|
| `supabase/migrations/001_fiscal_calendar.sql` | fiscal_calendar reference table | ✅ Run |
| `supabase/migrations/002_core_tables.sql` | files, invoices, costs | ✅ Run |
| `supabase/migrations/003_staging_invoiced_files_audit.sql` | stg_invoiced_files_audit (now in staging schema) | ✅ Run |
| `supabase/migrations/004_views.sql` | All 5 canonical views | ✅ Run |
| `supabase/migrations/005_staging_schema.sql` | staging schema + 7 new staging tables + moved stg_invoiced_files_audit | ✅ Run |

---

## Security Configuration

All security is live in Supabase. Summary:

**Raw tables (staging.* + public.files/invoices/costs/fiscal_calendar)**
- RLS: ON
- Policies: NONE
- Result: anon and authenticated keys return zero rows. Verified with `SET LOCAL ROLE anon; SELECT * FROM files LIMIT 1;` → `ERROR 42501: permission denied`

**Views (public.v_*)**
- `REVOKE ALL` on all views from `anon` and `PUBLIC`
- `dashboard_reader` role: SELECT only on all 5 views
- `authenticated` role: member of `dashboard_reader` (inherits SELECT via role membership)
- `security_invoker = false` on views: views run as postgres (BYPASSRLS), so authenticated users can read views without needing direct table access

**Grant audit (clean state — 5 rows only):**
```
dashboard_reader | v_gross_profit_posted         | SELECT
dashboard_reader | v_invoiced_file_count_by_period | SELECT
dashboard_reader | v_invoiced_files               | SELECT
dashboard_reader | v_post_invoice_activity        | SELECT
dashboard_reader | v_projected_gp_incl_accruals   | SELECT
```

---

## Fiscal Calendar

Populated with FY2025 and FY2026 (12 periods each, 4-5-4 calendar).

| FY | Start | End | Periods |
|---|---|---|---|
| 2025 | 2025-01-06 | 2026-01-04 | P01–P12 |
| 2026 | 2026-01-05 | 2027-01-03 | P01–P12 |

Named `FY2025-P01` through `FY2026-P12`. fiscal_week calculated from days since fiscal year start.

**Note:** March 2026 was corrected from 3/8/2026 (typo — same as Feb end) to 3/9/2026 start.

---

## Ingest Job (TypeScript/Node.js)

Location: `ingest/` in the project repo.

**Built:**
- `ingest/src/config.ts` — loads and validates all env vars at startup (fail-fast)
- `ingest/src/graph.ts` — Microsoft Graph client: site ID, drive ID, file listing, download
- `ingest/src/reports/invoiced-files-audit.ts` — full pipeline for invoiced files audit report
- `ingest/src/index.ts` — orchestrator, CLI `--date YYYY-MM-DD` arg support
- `ingest/package.json`, `ingest/tsconfig.json`, `ingest/.env.example`

**Not yet built:**
- Report handlers for the 6 new staging tables (stg_ar_aged_outstanding, stg_unbilled_shipments, etc.)
- Handler for stg_job_profit_detail (placeholder table, columns TBD)

**⚠️ Code update needed:** `invoiced-files-audit.ts` references `'stg_invoiced_files_audit'` in the public schema. Now that the table moved to staging schema, the Supabase client calls need to change to `{ schema: 'staging' }`. Example:
```typescript
// Before
supabase.from('stg_invoiced_files_audit').upsert(...)

// After
supabase.schema('staging').from('stg_invoiced_files_audit').upsert(...)
```

---

## GitHub Actions Workflow

File: `.github/workflows/ingest.yml`

- Cron: `0 */3 * * *` (every 3 hours) — **exact daily time TBD**
- Manual dispatch: supports `report_date` (YYYY-MM-DD) and `dry_run` inputs
- Uploads logs as artifact on failure (7-day retention)

**Secrets needed (not yet wired):**

| Secret | Description |
|---|---|
| `AZURE_TENANT_ID` | Azure AD tenant |
| `AZURE_CLIENT_ID` | App registration client ID |
| `AZURE_CLIENT_SECRET` | App registration secret |
| `SHAREPOINT_HOST` | `argentsexpress.sharepoint.com` |
| `SHAREPOINT_SITE_PATH` | `/sites/DashboardsReports` |
| `SHAREPOINT_DRIVE_NAME` | Drive name containing the reports folder |
| `SHAREPOINT_REPORTS_FOLDER` | `Administration/Supabase Migration Project/Cargowise Daily File Dumps` |
| `SUPABASE_URL` | Project URL from Supabase settings |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS) |

---

## CargoWise Source Files

All 7 daily files live in SharePoint at:
`argentsexpress.sharepoint.com/sites/DashboardsReports/Shared Documents/Administration/Supabase Migration Project/Cargowise Daily File Dumps`

| File name pattern | Staging table | Columns confirmed? |
|---|---|---|
| `AR Aged Outstanding Transactions - Summa (...)` | `stg_ar_aged_outstanding` | ✅ Yes |
| `Argents Express Group Shipments with no (...)` | `stg_unbilled_shipments` | ✅ Yes |
| `HHH Job Profit - Detail by Job Tuesday, (...)` | `stg_job_profit_detail` | ❌ 406 — too large for Graph API text extraction; read xlsx directly at ingest time |
| `HHH Job Profit Forwarding-Summary by Loc (...)` | `stg_job_profit_summary` | ✅ Yes |
| `HHH Job Status Summary Report Tuesday, (...)` | `stg_job_status_summary` | ✅ Yes |
| `HHH Shipment Profile Report Monday, (...)` | `stg_shipment_profile` | ✅ Yes (38 columns) |
| `HHH WIP Revenue and Accrued Costs Report (...)` | `stg_wip_accrued_costs` | ✅ Yes |

---

## Locked Business Definitions

These are confirmed and must not change without leadership sign-off:

| Metric | Definition |
|---|---|
| **Invoiced file count** | COUNT(DISTINCT job_file_no) WHERE ≥1 posted AR invoice exists, counted by `first_invoice_date` |
| **Reconciliation anchor** | **175** — not 206. 206 counts invoices; 175 counts distinct files. |
| **Canonical GP** | Posted revenue minus posted actual costs only. NEVER blended with accruals or WIP. |
| **Period assignment** | `first_invoice_date` for invoiced files; `job_date` for pre-invoice WIP |
| **Supplementary invoices** | Add revenue to an already-invoiced file. Do NOT re-count the file. |
| **Projected GP** | Includes accruals + WIP. Must be labelled "Projected GP incl. accruals" everywhere — never presented as the P&L number. |

---

## Open Definitions (TODO — do not guess)

| Item | Status |
|---|---|
| Unbilled definition | ~31 files sit between 175 and 206. Confirm: "unbilled" = no AR header, or = has header but nothing posted? |
| File status ladder | Placeholder values in `files.file_status`. Confirm exact statuses and transition rules with Argents. |
| Credit/re-bill treatment | If a file is fully credited to zero, does it still count as "invoiced"? |
| WIP vs accrual boundary | Confirm exact boundary between `wip` and `accrued` cost types. |
| Daily ingest time | Currently every 3h. Confirm the exact daily schedule with Argents. |

---

## What's Done

- [x] Supabase project created
- [x] All 5 SQL migrations written and run
- [x] fiscal_calendar populated (FY2025 + FY2026)
- [x] Security lockdown: RLS on all tables, dashboard_reader role, anon fully blocked
- [x] TypeScript ingest job scaffolded (config, Graph client, invoiced-files-audit handler)
- [x] GitHub Actions workflow written
- [x] staging schema created with 8 tables (all with RLS + idempotency keys)
- [x] All 7 CargoWise file structures inspected from SharePoint

## What's Next

1. **Fix ingest schema reference** — update `invoiced-files-audit.ts` to target `staging` schema
2. **Wire GitHub secrets** — add all 9 secrets to the GitHub repo
3. **Write ingest handlers for 6 new reports** — one per staging table
4. **Run dry-run ingest** — `DRY_RUN=true` against real CargoWise files to validate COLUMN_MAP for each report
5. **Inspect Job Profit Detail xlsx** — at ingest time, print headers to confirm column names, then add typed columns to `stg_job_profit_detail`
6. **Populate core tables** — once ingest runs, transform staging → files/invoices/costs
7. **Verify reconciliation** — `SELECT SUM(invoiced_file_count) FROM v_invoiced_file_count_by_period` must = 175
8. **Resolve open definitions** (unbilled, file status ladder, credit treatment)
9. **Repoint dashboards** — update Argents Intelligence and Management Dashboard to query canonical views

---

## Key File Locations

```
Supabase Migration Project/
├── PROJECT_STATE.md                          ← this file
├── supabase/
│   └── migrations/
│       ├── 001_fiscal_calendar.sql
│       ├── 002_core_tables.sql
│       ├── 003_staging_invoiced_files_audit.sql
│       ├── 004_views.sql
│       └── 005_staging_schema.sql
└── ingest/
    ├── .env.example
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── config.ts
        ├── graph.ts
        ├── index.ts
        └── reports/
            └── invoiced-files-audit.ts       ← needs schema update
```

SharePoint reports folder:
`https://argentsexpress.sharepoint.com/sites/DashboardsReports/Shared Documents/Administration/Supabase Migration Project/Cargowise Daily File Dumps`
