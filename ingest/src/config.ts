/**
 * config.ts
 * Loads and validates all environment variables at startup.
 * Fail fast: if a required var is missing, the job errors before
 * touching SharePoint or Supabase.
 */

import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  azure: {
    tenantId:     required('AZURE_TENANT_ID'),
    clientId:     required('AZURE_CLIENT_ID'),
    clientSecret: required('AZURE_CLIENT_SECRET'),
  },
  sharepoint: {
    host:          required('SHAREPOINT_HOST'),
    sitePath:      required('SHAREPOINT_SITE_PATH'),
    driveName:     required('SHAREPOINT_DRIVE_NAME'),
    reportsFolder: required('SHAREPOINT_REPORTS_FOLDER'),
  },
  supabase: {
    url:            required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  dryRun:   process.env.DRY_RUN === 'true',
  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
} as const;
