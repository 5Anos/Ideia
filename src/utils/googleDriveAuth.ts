import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
];

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of GOOGLE_DRIVE_SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
});

// Cache do token de acesso estritamente em memória (nunca guardar em localStorage ou sessionStorage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;

export function initGoogleDriveAuth(
  onAuthSuccess?: (user: User, accessToken: string) => void,
  onAuthCleared?: () => void
): () => void {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (user && cachedAccessToken) {
      onAuthSuccess?.(user, cachedAccessToken);
    } else if (!isSigningIn) {
      if (!user) {
        cachedAccessToken = null;
      }
      onAuthCleared?.();
    }
  });
}

export async function signInWithCompanyGoogleDrive(): Promise<{
  user: User;
  accessToken: string;
} | null> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Não foi possível obter o token de acesso do Google Drive.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
}

export function getGoogleDriveAccessToken(): string | null {
  return cachedAccessToken;
}

export function getCurrentGoogleUser(): User | null {
  return auth.currentUser;
}

export async function signOutGoogleDrive(): Promise<void> {
  cachedAccessToken = null;
  await auth.signOut();
}
