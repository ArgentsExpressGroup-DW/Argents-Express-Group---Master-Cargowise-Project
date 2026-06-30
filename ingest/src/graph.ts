/**
 * graph.ts
 * Microsoft Graph API client.
 * Authenticates with client credentials (app registration),
 * resolves the SharePoint site + drive, and downloads files.
 */

import { ClientSecretCredential } from '@azure/identity';
import { Client, type AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { config } from './config.js';
import { logger } from './logger.js';

/** Build a Graph client authenticated via client-credentials flow. */
function buildGraphClient(): Client {
  const credential = new ClientSecretCredential(
    config.azure.tenantId,
    config.azure.clientId,
    config.azure.clientSecret,
  );

  const authProvider: AuthenticationProvider = {
    getAccessToken: async () => {
      const token = await credential.getToken('https://graph.microsoft.com/.default');
      if (!token) throw new Error('Failed to acquire Graph API token');
      return token.token;
    },
  };

  return Client.initWithMiddleware({ authProvider });
}

const graphClient = buildGraphClient();

/** Resolve the numeric SharePoint site ID from host + site path. */
async function getSiteId(): Promise<string> {
  const { host, sitePath } = config.sharepoint;
  logger.debug('Resolving SharePoint site ID', { host, sitePath });
  // Graph endpoint: /sites/{hostname}:{path}
  const site = await graphClient
    .api(`/sites/${host}:${sitePath}`)
    .get() as { id: string };
  return site.id;
}

/** Resolve the drive ID by drive display name. */
async function getDriveId(siteId: string): Promise<string> {
  const { driveName } = config.sharepoint;
  logger.debug('Resolving drive', { driveName });
  const result = await graphClient
    .api(`/sites/${siteId}/drives`)
    .get() as { value: Array<{ id: string; name: string }> };
  const drive = result.value.find(d => d.name === driveName);
  if (!drive) {
    throw new Error(
      `Drive "${driveName}" not found in site. Available drives: ${
        result.value.map(d => d.name).join(', ')
      }`
    );
  }
  return drive.id;
}

export interface DriveItem {
  id: string;
  name: string;
  lastModifiedDateTime: string;
  size: number;
}

/** List files in the configured CargoWise reports folder. */
export async function listReportFiles(): Promise<DriveItem[]> {
  const siteId  = await getSiteId();
  const driveId = await getDriveId(siteId);
  const folder  = config.sharepoint.reportsFolder;

  logger.info('Listing files in SharePoint folder', { folder });
  const result = await graphClient
    .api(`/drives/${driveId}/root:${folder}:/children`)
    .select('id,name,lastModifiedDateTime,size')
    .get() as { value: DriveItem[] };

  return result.value;
}

/**
 * Download a specific file by path within the reports folder.
 * Returns the raw file content as a Buffer.
 */
export async function downloadFile(fileName: string): Promise<Buffer> {
  const siteId  = await getSiteId();
  const driveId = await getDriveId(siteId);
  const folder  = config.sharepoint.reportsFolder;
  const path    = `${folder}/${fileName}`;

  logger.info('Downloading file from SharePoint', { path });
  const stream = await graphClient
    .api(`/drives/${driveId}/root:${path}:/content`)
    .getStream();

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Find the most recent file in the reports folder whose name matches
 * a given pattern (glob-style prefix or regex).
 */
export async function findLatestFile(namePattern: RegExp): Promise<DriveItem | null> {
  const files = await listReportFiles();
  const matches = files
    .filter(f => namePattern.test(f.name))
    .sort((a, b) =>
      new Date(b.lastModifiedDateTime).getTime() -
      new Date(a.lastModifiedDateTime).getTime()
    );
  return matches[0] ?? null;
}
