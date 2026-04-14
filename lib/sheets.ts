/**
 * lib/sheets.ts — Google Sheets sync via native fetch + REST API
 * No googleapis package. OAuth2 handled manually.
 *
 * One-time setup: place ~/.crux/google-credentials.json
 * (downloaded from Google Cloud Console → OAuth2 client credentials)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { tasksByProject, roiSummary, totalHours } from './db.ts';
import type { Project } from './db.ts';

const CRUX_DIR        = join(homedir(), '.crux');
const CREDS_PATH      = join(CRUX_DIR, 'google-credentials.json');
const TOKEN_PATH      = join(CRUX_DIR, 'google-token.json');
const SHEETS_BASE     = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_ENDPOINT  = 'https://oauth2.googleapis.com/token';

// ── Types ─────────────────────────────────────────────────────────────────────

interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

interface OAuthToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

// ── Token management ──────────────────────────────────────────────────────────

function loadCredentials(): OAuthCredentials {
  if (!existsSync(CREDS_PATH)) {
    throw new Error(
      `Google credentials not found at ${CREDS_PATH}.\n` +
      `Download OAuth2 credentials from Google Cloud Console and place them there.`
    );
  }
  const raw = JSON.parse(readFileSync(CREDS_PATH, 'utf8')) as { installed?: OAuthCredentials; web?: OAuthCredentials };
  return (raw.installed ?? raw.web)!;
}

function loadToken(): OAuthToken | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')) as OAuthToken; }
  catch { return null; }
}

function saveToken(token: OAuthToken): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function refreshToken(creds: OAuthCredentials, refreshToken: string): Promise<string> {
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${await resp.text()}`);
  const data = await resp.json() as { access_token: string; expires_in: number };
  const token = loadToken()!;
  token.access_token = data.access_token;
  token.expiry_date  = Date.now() + data.expires_in * 1000;
  saveToken(token);
  return data.access_token;
}

async function getAccessToken(): Promise<string> {
  const creds = loadCredentials();
  const token = loadToken();
  if (!token) throw new Error('Not authenticated. Run `crux auth google` to set up OAuth2.');
  if (Date.now() < token.expiry_date - 60_000) return token.access_token;
  return refreshToken(creds, token.refresh_token);
}

// ── Auth URL generator (for first-time setup) ─────────────────────────────────

export function getAuthUrl(): string {
  const creds = loadCredentials();
  const params = new URLSearchParams({
    client_id:     creds.client_id,
    redirect_uri:  'urn:ietf:wg:oauth:2.0:oob',
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/spreadsheets',
    access_type:   'offline',
  });
  return `https://accounts.google.com/o/oauth2/auth?${params}`;
}

export async function exchangeCode(code: string): Promise<void> {
  const creds = loadCredentials();
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri:  'urn:ietf:wg:oauth:2.0:oob',
      grant_type:    'authorization_code',
      code,
    }),
  });
  if (!resp.ok) throw new Error(`Code exchange failed: ${await resp.text()}`);
  const data = await resp.json() as { access_token: string; refresh_token: string; expires_in: number };
  saveToken({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expiry_date:   Date.now() + data.expires_in * 1000,
  });
}

// ── Sheets API helpers ────────────────────────────────────────────────────────

async function sheetsRequest(method: string, url: string, body?: unknown): Promise<unknown> {
  const token = await getAccessToken();
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`Sheets API ${method} ${url}: ${await resp.text()}`);
  return resp.json();
}

async function updateRange(spreadsheetId: string, range: string, values: unknown[][]): Promise<void> {
  await sheetsRequest(
    'PUT',
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { range, majorDimension: 'ROWS', values },
  );
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function syncToSheets(db: DatabaseSync, project: Project): Promise<void> {
  if (!project.sheets_id) throw new Error(`Project ${project.name} has no sheets_id configured.`);

  const tasks = tasksByProject(db, project.id);
  const roi   = roiSummary(db, project.id);
  const hours = totalHours(db, project.id);

  // Tasks tab
  const taskRows: unknown[][] = [
    ['Slug', 'Title', 'Phase', 'Status', 'Priority', 'Duration (days)', 'Float', 'Critical', 'GH Issue'],
    ...tasks.map(t => [
      t.slug, t.title, t.phase ?? '', t.status, t.priority,
      t.duration_days ?? '', t.float_days ?? '', t.is_critical ? 'yes' : 'no',
      t.gh_issue_number ?? '',
    ]),
  ];

  // Overview tab
  const overviewRows: unknown[][] = [
    ['Metric', 'Value'],
    ['Project', project.name],
    ['Type', project.type],
    ['Status', project.status],
    ['Total tasks', tasks.length],
    ['Done', tasks.filter(t => t.status === 'done').length],
    ['Open', tasks.filter(t => t.status === 'open').length],
    ['Hours invested', hours.toFixed(1)],
    ['Revenue (AUD)', roi.revenue.toFixed(2)],
    ['Cost (AUD)', roi.cost.toFixed(2)],
    ['Expected (AUD)', roi.expected.toFixed(2)],
  ];

  await updateRange(project.sheets_id, 'Tasks!A1', taskRows);
  await updateRange(project.sheets_id, 'Overview!A1', overviewRows);
}

// ── CSV export (zero-auth fallback) ──────────────────────────────────────────

export function exportCsv(db: DatabaseSync, project: Project): string {
  const tasks = tasksByProject(db, project.id);
  const header = ['slug','title','phase','status','priority','duration_days','float_days','is_critical','gh_issue_number'];
  const rows = tasks.map(t =>
    [t.slug, t.title, t.phase ?? '', t.status, t.priority,
     t.duration_days ?? '', t.float_days ?? '', t.is_critical, t.gh_issue_number ?? '']
    .map(v => `"${String(v).replace(/"/g, '""')}"`)
    .join(',')
  );
  return [header.join(','), ...rows].join('\n');
}
