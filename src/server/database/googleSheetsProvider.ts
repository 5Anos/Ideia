import {
  ALL_WORKSHEET_NAMES,
  columnIndexToLetter,
  WORKSHEET_HEADERS,
  type SchemaValidationReport,
  type WorksheetName,
} from './sheetSchema.ts';

export interface GoogleHttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
}

export interface GoogleHttpResponse {
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

export interface GoogleApiTransport {
  request(req: GoogleHttpRequest): Promise<GoogleHttpResponse>;
}

export class GoogleSheetsError extends Error {
  readonly code:
    | 'AUTH_ERROR'
    | 'ACCESS_DENIED'
    | 'NOT_FOUND'
    | 'QUOTA_EXCEEDED'
    | 'INVALID_SCHEMA'
    | 'API_ERROR';
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: GoogleSheetsError['code'],
    httpStatus: number,
    message: string,
    retryable = false
  ) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

export interface SpreadsheetSheetInfo {
  sheetId: number;
  title: string;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string;
  spreadsheetUrl: string;
  sheets: SpreadsheetSheetInfo[];
}

export interface GoogleUserIdentity {
  email: string;
  name: string;
  sub: string;
}

export interface SpreadsheetListItem {
  id: string;
  name: string;
  modifiedTime: string;
  webViewLink: string;
}

const defaultFetchTransport: GoogleApiTransport = {
  async request(req: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    return {
      status: res.status,
      json: () => res.json(),
      text: () => res.text(),
    };
  },
};

let activeTransport: GoogleApiTransport = defaultFetchTransport;
let retryBaseDelayMs = 250;

export function setGoogleApiTransport(transport: GoogleApiTransport | null): void {
  activeTransport = transport ?? defaultFetchTransport;
}

export function setGoogleRetryBaseDelayForTests(delayMs: number): void {
  retryBaseDelayMs = Math.max(0, delayMs);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeGoogleJson<T>(
  req: GoogleHttpRequest,
  maxRetries = 3
): Promise<T> {
  let attempt = 0;
  let lastError: GoogleSheetsError | null = null;

  while (attempt <= maxRetries) {
    try {
      const res = await activeTransport.request(req);
      if (res.status >= 200 && res.status < 300) {
        return (await res.json()) as T;
      }

      const rawText = await res.text().catch(() => '');
      let apiMsg = rawText;
      try {
        const parsed = JSON.parse(rawText) as { error?: { message?: string } | string; error_description?: string };
        if (typeof parsed.error === 'string') {
          apiMsg = parsed.error_description || parsed.error;
        } else if (parsed.error?.message) {
          apiMsg = parsed.error.message;
        }
      } catch {
        // manter texto bruto
      }

      if (res.status === 401) {
        throw new GoogleSheetsError(
          'AUTH_ERROR',
          401,
          `Autorização Google inválida ou expirada: ${apiMsg || 'Unauthorized'}`,
          false
        );
      }
      if (res.status === 403) {
        if (/quota|rateLimit|userRateLimit/i.test(apiMsg)) {
          lastError = new GoogleSheetsError(
            'QUOTA_EXCEEDED',
            429,
            `Limite de pedidos da API Google Sheets atingido: ${apiMsg}`,
            true
          );
        } else {
          throw new GoogleSheetsError(
            'ACCESS_DENIED',
            403,
            `Sem acesso à folha de cálculo no Google Sheets: ${apiMsg || 'Permissão negada.'}`,
            false
          );
        }
      } else if (res.status === 404) {
        throw new GoogleSheetsError(
          'NOT_FOUND',
          404,
          `Folha de cálculo não encontrada ou eliminada no Google Drive: ${apiMsg || 'Not Found'}`,
          false
        );
      } else if (res.status === 429 || res.status >= 500) {
        lastError = new GoogleSheetsError(
          res.status === 429 ? 'QUOTA_EXCEEDED' : 'API_ERROR',
          res.status,
          `Erro temporário Google API (${res.status}): ${apiMsg || 'Serviço indisponível'}`,
          true
        );
      } else {
        throw new GoogleSheetsError(
          'API_ERROR',
          res.status,
          `Erro na API Google (${res.status}): ${apiMsg || 'Pedido inválido'}`,
          false
        );
      }
    } catch (err) {
      if (err instanceof GoogleSheetsError) {
        if (!err.retryable) throw err;
        lastError = err;
      } else {
        lastError = new GoogleSheetsError(
          'API_ERROR',
          503,
          err instanceof Error ? err.message : 'Falha de rede ao contactar APIs Google.',
          true
        );
      }
    }

    if (attempt >= maxRetries) {
      break;
    }
    const backoff = retryBaseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 40);
    await sleep(backoff);
    attempt++;
  }

  throw lastError ?? new GoogleSheetsError('API_ERROR', 503, 'Falha após múltiplas tentativas na API Google.');
}

export async function verifyGoogleTokenIdentity(accessToken: string): Promise<GoogleUserIdentity> {
  const data = await executeGoogleJson<{ email?: string; name?: string; sub?: string }>({
    url: 'https://www.googleapis.com/oauth2/v3/userinfo',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!data.email) {
    throw new GoogleSheetsError('AUTH_ERROR', 401, 'Não foi possível obter o email verificado da conta Google.');
  }
  return {
    email: data.email.trim().toLowerCase(),
    name: data.name || data.email,
    sub: data.sub || '',
  };
}

export async function getSpreadsheetMetadata(
  accessToken: string,
  spreadsheetId: string
): Promise<SpreadsheetMetadata> {
  const fields = encodeURIComponent('spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))');
  const data = await executeGoogleJson<{
    spreadsheetId: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  }>({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${fields}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title || 'Folha de Cálculo MANDATO',
    spreadsheetUrl:
      data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${encodeURIComponent(data.spreadsheetId)}/edit`,
    sheets: (data.sheets || [])
      .map((s) => ({
        sheetId: Number(s.properties?.sheetId ?? 0),
        title: String(s.properties?.title ?? ''),
      }))
      .filter((s) => s.title),
  };
}

export async function listUserSpreadsheets(accessToken: string): Promise<SpreadsheetListItem[]> {
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
  const fields = encodeURIComponent('files(id,name,modifiedTime,webViewLink)');
  const data = await executeGoogleJson<{
    files?: Array<{ id?: string; name?: string; modifiedTime?: string; webViewLink?: string }>;
  }>({
    url: `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=modifiedTime%20desc&pageSize=30`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return (data.files || [])
    .filter((f) => f.id && f.name)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      modifiedTime: String(f.modifiedTime || ''),
      webViewLink: String(f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`),
    }));
}

export async function createCompanySpreadsheet(
  accessToken: string,
  title: string
): Promise<SpreadsheetMetadata> {
  const created = await executeGoogleJson<{
    spreadsheetId: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  }>({
    url: 'https://sheets.googleapis.com/v4/spreadsheets',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title,
        locale: 'pt_PT',
        timeZone: 'Europe/Lisbon',
      },
      sheets: ALL_WORKSHEET_NAMES.map((ws) => ({
        properties: {
          title: ws,
          gridProperties: {
            frozenRowCount: 1,
          },
        },
      })),
    }),
  });

  const meta: SpreadsheetMetadata = {
    spreadsheetId: created.spreadsheetId,
    title: created.properties?.title || title,
    spreadsheetUrl:
      created.spreadsheetUrl ||
      `https://docs.google.com/spreadsheets/d/${encodeURIComponent(created.spreadsheetId)}/edit`,
    sheets: (created.sheets || []).map((s) => ({
      sheetId: Number(s.properties?.sheetId ?? 0),
      title: String(s.properties?.title ?? ''),
    })),
  };

  // Escrever cabeçalhos de todas as 20 abas em lote único
  const valueUpdates = ALL_WORKSHEET_NAMES.map((ws) => {
    const headers = WORKSHEET_HEADERS[ws];
    const endCol = columnIndexToLetter(headers.length - 1);
    return {
      range: `'${ws}'!A1:${endCol}1`,
      values: [[...headers]],
    };
  });

  await batchUpdateValues(accessToken, meta.spreadsheetId, valueUpdates);
  return meta;
}

export async function batchGetRanges(
  accessToken: string,
  spreadsheetId: string,
  ranges: string[]
): Promise<Map<string, string[][]>> {
  if (ranges.length === 0) return new Map();
  const params = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const data = await executeGoogleJson<{
    valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
  }>({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const result = new Map<string, string[][]>();
  const valueRanges = data.valueRanges || [];
  for (let i = 0; i < ranges.length; i++) {
    const reqRange = ranges[i];
    const sheetTitle = reqRange.split('!')[0].replace(/^'|'$/g, '');
    const vr = valueRanges[i];
    const rows = (vr?.values || []).map((row) =>
      row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
    );
    result.set(sheetTitle, rows);
  }
  return result;
}

export async function validateSpreadsheetSchema(
  accessToken: string,
  spreadsheetId: string
): Promise<{ metadata: SpreadsheetMetadata; report: SchemaValidationReport }> {
  const metadata = await getSpreadsheetMetadata(accessToken, spreadsheetId);
  const existingTitles = new Set(metadata.sheets.map((s) => s.title));

  const missingWorksheets: WorksheetName[] = [];
  const presentWorksheets: WorksheetName[] = [];

  for (const ws of ALL_WORKSHEET_NAMES) {
    if (!existingTitles.has(ws)) {
      missingWorksheets.push(ws);
    } else {
      presentWorksheets.push(ws);
    }
  }

  const headerMismatches: SchemaValidationReport['headerMismatches'] = [];
  if (presentWorksheets.length > 0) {
    const ranges = presentWorksheets.map((ws) => `'${ws}'!A1:Z1`);
    const headersMap = await batchGetRanges(accessToken, spreadsheetId, ranges);

    for (const ws of presentWorksheets) {
      const expected = [...WORKSHEET_HEADERS[ws]];
      const rows = headersMap.get(ws) || [];
      const actual = rows[0] || [];
      const missingCols = expected.filter((col, idx) => actual[idx] !== col);
      if (missingCols.length > 0) {
        headerMismatches.push({
          worksheet: ws,
          missingColumns: missingCols,
          expectedColumns: expected,
          actualColumns: actual,
        });
      }
    }
  }

  return {
    metadata,
    report: {
      valid: missingWorksheets.length === 0 && headerMismatches.length === 0,
      missingWorksheets,
      headerMismatches,
    },
  };
}

export async function ensureSpreadsheetSchema(
  accessToken: string,
  spreadsheetId: string
): Promise<{ metadata: SpreadsheetMetadata; report: SchemaValidationReport; createdTabs: string[]; updatedHeaders: string[] }> {
  const { metadata, report } = await validateSpreadsheetSchema(accessToken, spreadsheetId);
  const createdTabs: string[] = [];
  const updatedHeaders: string[] = [];

  if (report.missingWorksheets.length > 0) {
    await executeGoogleJson({
      url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: report.missingWorksheets.map((ws) => ({
          addSheet: {
            properties: {
              title: ws,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        })),
      }),
    });
    createdTabs.push(...report.missingWorksheets);
  }

  const headerUpdates: Array<{ range: string; values: string[][] }> = [];
  for (const ws of report.missingWorksheets) {
    const expected = [...WORKSHEET_HEADERS[ws]];
    const endCol = columnIndexToLetter(expected.length - 1);
    headerUpdates.push({
      range: `'${ws}'!A1:${endCol}1`,
      values: [expected],
    });
    updatedHeaders.push(ws);
  }

  // Só escreve cabeçalhos automaticamente em abas que estavam vazias na linha 1 (nunca destrói abas preenchidas)
  for (const mismatch of report.headerMismatches) {
    if (mismatch.actualColumns.length === 0) {
      const endCol = columnIndexToLetter(mismatch.expectedColumns.length - 1);
      headerUpdates.push({
        range: `'${mismatch.worksheet}'!A1:${endCol}1`,
        values: [mismatch.expectedColumns],
      });
      updatedHeaders.push(mismatch.worksheet);
    }
  }

  if (headerUpdates.length > 0) {
    await batchUpdateValues(accessToken, spreadsheetId, headerUpdates);
  }

  const revalidated = await validateSpreadsheetSchema(accessToken, spreadsheetId);
  return {
    metadata: revalidated.metadata,
    report: revalidated.report,
    createdTabs,
    updatedHeaders,
  };
}

export async function appendWorksheetRows(
  accessToken: string,
  spreadsheetId: string,
  worksheet: WorksheetName,
  rows: string[][]
): Promise<void> {
  if (rows.length === 0) return;
  const endCol = columnIndexToLetter(WORKSHEET_HEADERS[worksheet].length - 1);
  const range = encodeURIComponent(`'${worksheet}'!A1:${endCol}1`);
  await executeGoogleJson({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      majorDimension: 'ROWS',
      values: rows,
    }),
  });
}

export async function updateWorksheetRow(
  accessToken: string,
  spreadsheetId: string,
  worksheet: WorksheetName,
  rowNumberOneBased: number,
  values: string[]
): Promise<void> {
  const endCol = columnIndexToLetter(WORKSHEET_HEADERS[worksheet].length - 1);
  const range = encodeURIComponent(`'${worksheet}'!A${rowNumberOneBased}:${endCol}${rowNumberOneBased}`);
  await executeGoogleJson({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=RAW`,
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      majorDimension: 'ROWS',
      values: [values],
    }),
  });
}

export async function batchUpdateValues(
  accessToken: string,
  spreadsheetId: string,
  updates: Array<{ range: string; values: string[][] }>
): Promise<void> {
  if (updates.length === 0) return;
  await executeGoogleJson({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: updates,
    }),
  });
}

export async function deleteWorksheetRow(
  accessToken: string,
  spreadsheetId: string,
  sheetId: number,
  rowIndexZeroBased: number
): Promise<void> {
  await executeGoogleJson({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndexZeroBased,
              endIndex: rowIndexZeroBased + 1,
            },
          },
        },
      ],
    }),
  });
}

export async function exchangeGoogleOAuthCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope: string; token_type: string }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  return executeGoogleJson({
    url: 'https://oauth2.googleapis.com/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
}

export async function refreshGoogleOAuthToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access_token: string; expires_in: number; scope?: string; token_type?: string }> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  return executeGoogleJson({
    url: 'https://oauth2.googleapis.com/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
}

export async function revokeGoogleOAuthToken(token: string): Promise<void> {
  if (!token) return;
  try {
    await activeTransport.request({
      url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch {
    // revogação remota é best-effort; o segredo local já é eliminado
  }
}

export function extractSpreadsheetIdFromInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch?.[1]) return urlMatch[1];
  if (/^[a-zA-Z0-9-_]{15,}$/.test(trimmed)) return trimmed;
  return '';
}
