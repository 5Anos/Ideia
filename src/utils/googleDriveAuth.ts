import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const GOOGLE_SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

function buildGoogleProvider(loginHint?: string): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_SHEETS_SCOPES) {
    provider.addScope(scope);
  }
  const params: Record<string, string> = {
    prompt: 'consent select_account',
  };
  if (loginHint?.trim()) {
    params.login_hint = loginHint.trim();
  }
  provider.setCustomParameters(params);
  return provider;
}

// Token transitório usado apenas durante o handshake de entrega ao servidor (nunca persistido no browser)
let isSigningIn = false;
let transientAccessToken: string | null = null;

export function initGoogleDriveAuth(
  onAuthCleared?: () => void
): () => void {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (!user && !isSigningIn) {
      transientAccessToken = null;
      onAuthCleared?.();
    }
  });
}

export function clearGoogleAccessTokenFromMemory(): void {
  transientAccessToken = null;
}

export async function requestGoogleWorkspaceAccessToken(loginHint?: string): Promise<{
  email: string | null;
  displayName: string | null;
  accessToken: string;
} | null> {
  try {
    isSigningIn = true;
    const provider = buildGoogleProvider(loginHint);
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Não foi possível obter o token de acesso Google Workspace.');
    }
    transientAccessToken = credential.accessToken;
    return {
      email: result.user.email,
      displayName: result.user.displayName,
      accessToken: transientAccessToken,
    };
  } finally {
    isSigningIn = false;
  }
}

export async function signOutGoogleDrive(): Promise<void> {
  transientAccessToken = null;
  await auth.signOut().catch(() => undefined);
}
