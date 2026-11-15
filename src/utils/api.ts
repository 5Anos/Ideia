const TOKEN_STORAGE_KEY = 'mandato_session_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignorar erros de storage em modo privado
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly connectionStatus?: string
  ) {
    super(message);
  }
}

export function isDatabaseNotConnectedError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === 'DATABASE_NOT_CONNECTED' ||
      err.code === 'GOOGLE_AUTH_EXPIRED' ||
      err.code === 'GOOGLE_SHEET_INACCESSIBLE')
  );
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    let errMsg = `Erro HTTP ${res.status}`;
    let errCode: string | undefined;
    let connStatus: string | undefined;
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as {
        error?: string;
        reason?: string;
        code?: string;
        connection_status?: string;
      };
      errMsg = data.error || data.reason || errMsg;
      errCode = data.code;
      connStatus = data.connection_status;
    }
    throw new ApiError(res.status, errMsg, errCode, connStatus);
  }

  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}
