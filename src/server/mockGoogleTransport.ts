import type { GoogleApiTransport, GoogleHttpRequest, GoogleHttpResponse } from './database/googleSheetsProvider.ts';

interface SheetTab {
  sheetId: number;
  title: string;
  rows: string[][];
}

export interface MockSpreadsheet {
  spreadsheetId: string;
  title: string;
  ownerEmail: string;
  sharedWith: Set<string>;
  sheets: SheetTab[];
}

export class MockGoogleApiTransport implements GoogleApiTransport {
  tokens = new Map<string, { email: string; name: string; sub: string; expired?: boolean }>();
  authCodes = new Map<string, { email: string; accessToken: string; refreshToken: string }>();
  refreshTokens = new Map<string, { email: string; revoked?: boolean }>();
  spreadsheets = new Map<string, MockSpreadsheet>();
  revokedTokens: string[] = [];
  requestLog: Array<{ method: string; url: string }> = [];
  private injectedErrors: Array<{ matchUrl?: RegExp; status: number; body: unknown }> = [];
  private nextSheetNumericId = 100;
  private nextSpreadsheetCounter = 1;

  registerAccessToken(token: string, email: string, name?: string): void {
    this.tokens.set(token, {
      email: email.trim().toLowerCase(),
      name: name || email.split('@')[0],
      sub: `sub-${email}`,
    });
  }

  expireAccessToken(token: string): void {
    const entry = this.tokens.get(token);
    if (entry) entry.expired = true;
  }

  registerAuthCode(code: string, email: string, accessToken: string, refreshToken: string): void {
    const normEmail = email.trim().toLowerCase();
    this.authCodes.set(code, { email: normEmail, accessToken, refreshToken });
    this.registerAccessToken(accessToken, normEmail);
    this.refreshTokens.set(refreshToken, { email: normEmail });
  }

  injectNextError(status: number, body: unknown, matchUrl?: RegExp): void {
    this.injectedErrors.push({ status, body, matchUrl });
  }

  seedCustomSpreadsheet(params: {
    spreadsheetId: string;
    title: string;
    ownerEmail: string;
    tabs: Array<{ title: string; rows?: string[][] }>;
  }): MockSpreadsheet {
    const sheet: MockSpreadsheet = {
      spreadsheetId: params.spreadsheetId,
      title: params.title,
      ownerEmail: params.ownerEmail.trim().toLowerCase(),
      sharedWith: new Set(),
      sheets: params.tabs.map((t) => ({
        sheetId: this.nextSheetNumericId++,
        title: t.title,
        rows: t.rows ? t.rows.map((r) => [...r]) : [],
      })),
    };
    this.spreadsheets.set(sheet.spreadsheetId, sheet);
    return sheet;
  }

  private jsonResponse(status: number, data: unknown): GoogleHttpResponse {
    const raw = JSON.stringify(data);
    return {
      status,
      json: async () => data,
      text: async () => raw,
    };
  }

  private resolveToken(req: GoogleHttpRequest): { email: string; name: string; sub: string } | null {
    const auth = req.headers?.Authorization || req.headers?.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;
    const entry = this.tokens.get(token);
    if (!entry || entry.expired) return null;
    return entry;
  }

  private parseA1Range(rangeStr: string): { title: string; startRow: number; endRow: number | null } {
    const bangIdx = rangeStr.indexOf('!');
    const rawTitle = bangIdx >= 0 ? rangeStr.slice(0, bangIdx) : rangeStr;
    const title = rawTitle.replace(/^'|'$/g, '');
    const cellPart = bangIdx >= 0 ? rangeStr.slice(bangIdx + 1) : 'A1:Z';
    const match = cellPart.match(/[A-Z]+(\d+)(?::[A-Z]+(\d+)?)?/i);
    const startRow = match?.[1] ? Number(match[1]) : 1;
    const endRow = match?.[2] ? Number(match[2]) : null;
    return { title, startRow, endRow };
  }

  async request(req: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    this.requestLog.push({ method: req.method, url: req.url });

    const errIdx = this.injectedErrors.findIndex((e) => !e.matchUrl || e.matchUrl.test(req.url));
    if (errIdx >= 0) {
      const [injected] = this.injectedErrors.splice(errIdx, 1);
      return this.jsonResponse(injected.status, injected.body);
    }

    const urlObj = new URL(req.url);

    // 1. OAuth Token Exchange & Refresh
    if (urlObj.hostname === 'oauth2.googleapis.com' && urlObj.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(req.body || '');
      const grantType = form.get('grant_type');
      if (grantType === 'authorization_code') {
        const code = form.get('code') || '';
        const rec = this.authCodes.get(code);
        if (!rec) {
          return this.jsonResponse(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
        }
        return this.jsonResponse(200, {
          access_token: rec.accessToken,
          refresh_token: rec.refreshToken,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
          token_type: 'Bearer',
        });
      }
      if (grantType === 'refresh_token') {
        const rt = form.get('refresh_token') || '';
        const rec = this.refreshTokens.get(rt);
        if (!rec || rec.revoked) {
          return this.jsonResponse(401, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
        }
        const newAccess = `refreshed_${rec.email}_${Date.now()}`;
        this.registerAccessToken(newAccess, rec.email);
        return this.jsonResponse(200, {
          access_token: newAccess,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      return this.jsonResponse(400, { error: 'unsupported_grant_type' });
    }

    // 2. OAuth Token Revocation
    if (urlObj.hostname === 'oauth2.googleapis.com' && urlObj.pathname === '/revoke') {
      const tok = urlObj.searchParams.get('token') || '';
      if (tok) {
        this.revokedTokens.push(tok);
        this.tokens.delete(tok);
        const rt = this.refreshTokens.get(tok);
        if (rt) rt.revoked = true;
      }
      return this.jsonResponse(200, {});
    }

    // 3. OAuth UserInfo
    if (urlObj.hostname === 'www.googleapis.com' && urlObj.pathname === '/oauth2/v3/userinfo') {
      const identity = this.resolveToken(req);
      if (!identity) {
        return this.jsonResponse(401, { error: { message: 'Invalid Credentials' } });
      }
      return this.jsonResponse(200, identity);
    }

    // 4. Drive v3 List Spreadsheets
    if (urlObj.hostname === 'www.googleapis.com' && urlObj.pathname === '/drive/v3/files') {
      const identity = this.resolveToken(req);
      if (!identity) {
        return this.jsonResponse(401, { error: { message: 'Invalid Credentials' } });
      }
      const files = Array.from(this.spreadsheets.values())
        .filter((s) => s.ownerEmail === identity.email || s.sharedWith.has(identity.email))
        .map((s) => ({
          id: s.spreadsheetId,
          name: s.title,
          modifiedTime: new Date().toISOString(),
          webViewLink: `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit`,
        }));
      return this.jsonResponse(200, { files });
    }

    // 5. Sheets v4 API
    if (urlObj.hostname === 'sheets.googleapis.com') {
      const identity = this.resolveToken(req);
      if (!identity) {
        return this.jsonResponse(401, { error: { message: 'Invalid Credentials' } });
      }

      // Create spreadsheet
      if (urlObj.pathname === '/v4/spreadsheets' && req.method === 'POST') {
        const body = JSON.parse(req.body || '{}') as {
          properties?: { title?: string };
          sheets?: Array<{ properties?: { title?: string } }>;
        };
        const spreadsheetId = `mock-sheet-${this.nextSpreadsheetCounter++}-${Date.now()}`;
        const title = body.properties?.title || 'Sem título';
        const tabs: SheetTab[] = (body.sheets || []).map((s) => ({
          sheetId: this.nextSheetNumericId++,
          title: s.properties?.title || 'Folha1',
          rows: [],
        }));
        const created: MockSpreadsheet = {
          spreadsheetId,
          title,
          ownerEmail: identity.email,
          sharedWith: new Set(),
          sheets: tabs,
        };
        this.spreadsheets.set(spreadsheetId, created);
        return this.jsonResponse(200, {
          spreadsheetId,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
          properties: { title },
          sheets: tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })),
        });
      }

      const idMatch = urlObj.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/);
      if (!idMatch) {
        return this.jsonResponse(404, { error: { message: 'Endpoint not found' } });
      }
      const spreadsheetId = decodeURIComponent(idMatch[1]);
      const suffix = idMatch[2] || '';

      const sheet = this.spreadsheets.get(spreadsheetId);
      if (!sheet) {
        return this.jsonResponse(404, { error: { message: 'Spreadsheet not found' } });
      }
      if (sheet.ownerEmail !== identity.email && !sheet.sharedWith.has(identity.email)) {
        return this.jsonResponse(403, { error: { message: 'The caller does not have permission' } });
      }

      // Get metadata
      if (!suffix && req.method === 'GET') {
        return this.jsonResponse(200, {
          spreadsheetId: sheet.spreadsheetId,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`,
          properties: { title: sheet.title },
          sheets: sheet.sheets.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })),
        });
      }

      // values:batchGet
      if (suffix === '/values:batchGet' && req.method === 'GET') {
        const ranges = urlObj.searchParams.getAll('ranges');
        const valueRanges = ranges.map((r) => {
          const parsed = this.parseA1Range(r);
          const tab = sheet.sheets.find((t) => t.title === parsed.title);
          if (!tab) return { range: r, values: [] };
          const startIdx = Math.max(0, parsed.startRow - 1);
          const endIdx = parsed.endRow !== null ? parsed.endRow : tab.rows.length;
          return {
            range: r,
            values: tab.rows.slice(startIdx, endIdx).map((row) => [...row]),
          };
        });
        return this.jsonResponse(200, { spreadsheetId, valueRanges });
      }

      // values:batchUpdate
      if (suffix === '/values:batchUpdate' && req.method === 'POST') {
        const body = JSON.parse(req.body || '{}') as {
          data?: Array<{ range: string; values: unknown[][] }>;
        };
        for (const item of body.data || []) {
          const parsed = this.parseA1Range(item.range);
          const tab = sheet.sheets.find((t) => t.title === parsed.title);
          if (!tab) {
            return this.jsonResponse(400, { error: { message: `Unknown worksheet ${parsed.title}` } });
          }
          const startIdx = Math.max(0, parsed.startRow - 1);
          for (let offset = 0; offset < item.values.length; offset++) {
            const rowIdx = startIdx + offset;
            while (tab.rows.length <= rowIdx) tab.rows.push([]);
            tab.rows[rowIdx] = item.values[offset].map((v) => (v === null || v === undefined ? '' : String(v)));
          }
        }
        return this.jsonResponse(200, { spreadsheetId, totalUpdatedRows: body.data?.length || 0 });
      }

      // :batchUpdate (addSheet, deleteDimension)
      if (suffix === ':batchUpdate' && req.method === 'POST') {
        const body = JSON.parse(req.body || '{}') as {
          requests?: Array<{
            addSheet?: { properties?: { title?: string } };
            deleteDimension?: {
              range?: { sheetId?: number; dimension?: string; startIndex?: number; endIndex?: number };
            };
          }>;
        };
        for (const op of body.requests || []) {
          if (op.addSheet?.properties?.title) {
            const title = op.addSheet.properties.title;
            if (!sheet.sheets.some((t) => t.title === title)) {
              sheet.sheets.push({
                sheetId: this.nextSheetNumericId++,
                title,
                rows: [],
              });
            }
          } else if (op.deleteDimension?.range) {
            const r = op.deleteDimension.range;
            const tab = sheet.sheets.find((t) => t.sheetId === r.sheetId);
            if (tab && r.dimension === 'ROWS' && typeof r.startIndex === 'number') {
              const count = Math.max(1, (r.endIndex ?? r.startIndex + 1) - r.startIndex);
              tab.rows.splice(r.startIndex, count);
            }
          }
        }
        return this.jsonResponse(200, { spreadsheetId, replies: [] });
      }

      // values/{range}:append
      const appendMatch = suffix.match(/^\/values\/(.+):append$/);
      if (appendMatch && req.method === 'POST') {
        const parsed = this.parseA1Range(decodeURIComponent(appendMatch[1]));
        const tab = sheet.sheets.find((t) => t.title === parsed.title);
        if (!tab) {
          return this.jsonResponse(400, { error: { message: `Unknown worksheet ${parsed.title}` } });
        }
        const body = JSON.parse(req.body || '{}') as { values?: unknown[][] };
        for (const row of body.values || []) {
          tab.rows.push(row.map((v) => (v === null || v === undefined ? '' : String(v))));
        }
        return this.jsonResponse(200, { spreadsheetId, updates: { updatedRows: body.values?.length || 0 } });
      }

      // values/{range} PUT update row
      const putMatch = suffix.match(/^\/values\/(.+)$/);
      if (putMatch && req.method === 'PUT') {
        const parsed = this.parseA1Range(decodeURIComponent(putMatch[1]));
        const tab = sheet.sheets.find((t) => t.title === parsed.title);
        if (!tab) {
          return this.jsonResponse(400, { error: { message: `Unknown worksheet ${parsed.title}` } });
        }
        const body = JSON.parse(req.body || '{}') as { values?: unknown[][] };
        const startIdx = Math.max(0, parsed.startRow - 1);
        for (let offset = 0; offset < (body.values || []).length; offset++) {
          const rowIdx = startIdx + offset;
          while (tab.rows.length <= rowIdx) tab.rows.push([]);
          tab.rows[rowIdx] = (body.values![offset] || []).map((v) => (v === null || v === undefined ? '' : String(v)));
        }
        return this.jsonResponse(200, { spreadsheetId, updatedRows: body.values?.length || 0 });
      }
    }

    return this.jsonResponse(404, { error: { message: `Unhandled mock route: ${req.method} ${req.url}` } });
  }
}
