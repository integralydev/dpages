'use client';

import {
  AuthErrorCodes,
  browserSessionPersistence,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type AuthError,
} from 'firebase/auth';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { InactivityWarningBanner } from '@/components/auth/InactivityWarningBanner';
import { esborrarFiltresPersistents } from '@/hooks/useFiltrePersistent';
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout';
import { api, ApiError, setAuthTokenProvider, type UsuariApi } from '@/lib/api';
import { auth } from '@/lib/firebase';

// 30 min sense activitat real → logout automàtic, amb avís 2 min abans
// (decisió confirmada, Opció C). Veure useInactivityTimeout.ts pel
// mecanisme genèric i InactivityWarningBanner.tsx per l'avís.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const INACTIVITY_WARNING_MS = 28 * 60 * 1000;

// Clau de sessionStorage (no localStorage: ha de desaparèixer sola si es
// tanca el navegador, igual que la sessió mateixa amb browserSessionPersistence
// de sota) — /login la llegeix un cop per mostrar el missatge i l'esborra.
export const INACTIVITY_LOGOUT_FLAG_KEY = 'dpages:sessioTancadaPerInactivitat';

// Punto de inyección del token para lib/api.ts (tarea 3 de esta sesión) —
// se resuelve acá, una sola vez, apenas se importa este módulo: cada
// petición de la capa HTTP manda el ID token vigente del usuario de
// Firebase, o ninguno si no hay sesión (el backend lo rechaza con
// 401 NO_AUTENTICAT, contrato §2).
setAuthTokenProvider(async () => (auth.currentUser ? auth.currentUser.getIdToken() : null));

export type LoginResult =
  | { ok: true; user: UsuariApi }
  | { ok: false; reason: 'invalid' | 'inactive' | 'connexio' | 'massa-intents' };

// Firebase gestiona la pantalla de contrasenya (alta i restabliment són el
// mateix mecanisme: sendPasswordResetEmail / generatePasswordResetLink),
// nosaltres només controlem la pantalla de destí un cop la persona ja l'ha
// establerta — sempre torna a /login amb aquest query param.
export type PasswordResetResult =
  { ok: true } | { ok: false; reason: 'too-many-requests' | 'unknown' };

type AuthContextValue = {
  user: UsuariApi | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  requestPasswordReset: (email: string) => Promise<PasswordResetResult>;
};

// handleCodeInApp: true — Firebase ja no mostra la seva pròpia pantalla
// genèrica (hostejada a firebaseapp.com): redirigeix directe a la nostra
// pàgina (`/action?mode=resetPassword&oobCode=...`), que és qui crida
// verifyPasswordResetCode/confirmPasswordReset amb el SDK i, en acabar,
// torna a portar acá mateix (/login?passwordReset=success — sense tocar).
// Únic punt on es construeix per als 2 fluxos que controlem des del
// client (oblidat / canviar des de perfil): tots dos criden
// requestPasswordReset(), que és qui fa servir aquesta funció.
function passwordResetActionCodeSettings() {
  return { url: `${window.location.origin}/action`, handleCodeInApp: true };
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** `GET /jo` — usuario autenticado con rol y mòduls permesos, contrato §4.12. Devuelve `null` si el backend lo rechaza (token vencido, usuari.actiu=false). */
/**
 * GET /jo. Distingeix el cas real d'usuari desactivat (403 SENSE_PERMIS) de
 * qualsevol altre error (xarxa, bloqueig del navegador, error del servidor):
 * abans tots dos es mostraven com "usuari desactivat", i quan la petició ni
 * arribava al backend el missatge enganyava (cas real, 19/10/2026).
 */
async function fetchUsuariActual(): Promise<
  { usuari: UsuariApi } | { usuari: null; motiu: 'inactive' | 'connexio' }
> {
  try {
    return { usuari: await api.get<UsuariApi>('/jo') };
  } catch (caught) {
    const desactivat = caught instanceof ApiError && caught.codi === 'SENSE_PERMIS';
    return { usuari: null, motiu: desactivat ? 'inactive' : 'connexio' };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UsuariApi | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Firebase gestiona la sesión sola (persistida por el propio SDK, no a
    // mano en localStorage) — esto reemplaza la hidratación manual de antes.
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        // Tasca 36: també si la sessió es tanca per una altra via (token
        // revocat, signOut des d'una altra pestanya…), no només amb logout().
        esborrarFiltresPersistents();
        setUser(null);
        setIsLoading(false);
        return;
      }
      setUser((await fetchUsuariActual()).usuari);
      setIsLoading(false);
    });

    return unsubscribe;
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    try {
      // Opció A confirmada: la sessió viu només mentre el navegador/pestanya
      // estigui obert (browserSessionPersistence), no indefinidament com el
      // default de Firebase (browserLocalPersistence). S'ha de cridar ABANS
      // de signInWithEmailAndPassword — Firebase aplica la persistència
      // vigent en el moment en què s'estableix la sessió, no amb efecte
      // retroactiu sobre una sessió ja creada.
      await setPersistence(auth, browserSessionPersistence);
      await signInWithEmailAndPassword(auth, email, password);
    } catch (caught) {
      // Sense connexió amb Firebase o massa intents seguits: no és que la
      // contrasenya sigui incorrecta, i el missatge no ho ha de dir.
      const codi = (caught as { code?: string } | null)?.code;
      if (codi === 'auth/network-request-failed') return { ok: false, reason: 'connexio' };
      if (codi === 'auth/too-many-requests') return { ok: false, reason: 'massa-intents' };
      return { ok: false, reason: 'invalid' };
    }

    const resultat = await fetchUsuariActual();
    if (!resultat.usuari) {
      // GET /jo ha fallat amb el token recién emitido: o l'usuari està
      // desactivat (403 SENSE_PERMIS, contrato §4.12) o no s'ha pogut parlar
      // amb el backend. En tots dos casos no deixem una sessió de Firebase
      // viva si el backend no reconeix l'usuari.
      await signOut(auth);
      return { ok: false, reason: resultat.motiu };
    }

    setUser(resultat.usuari);
    return { ok: true, user: resultat.usuari };
  }, []);

  const logout = useCallback(() => {
    // Tasca 36: els filtres desats són de la sessió de qui la tanca.
    esborrarFiltresPersistents();
    void signOut(auth);
    setUser(null);
  }, []);

  // Distint de logout(): a més de tancar sessió, deixa una marca perquè
  // /login sàpiga per què (logout() "normal", per exemple des del menú de
  // l'usuari, no ha de mostrar cap missatge).
  const handleInactivityTimeout = useCallback(() => {
    try {
      window.sessionStorage.setItem(INACTIVITY_LOGOUT_FLAG_KEY, '1');
    } catch {
      // Entorns sense sessionStorage (mode privat estricte, etc.): es perd
      // el missatge a /login, però el logout en si no depèn d'això.
    }
    logout();
  }, [logout]);

  // Només corre amb sessió activa — `enabled: user !== null` ja cobreix
  // /login sol (allà `user` és null fins que es faci login), sense fer
  // falta cap comprovació addicional de ruta.
  const { isWarning, resetTimer } = useInactivityTimeout({
    enabled: user !== null,
    warningAfterMs: INACTIVITY_WARNING_MS,
    timeoutAfterMs: INACTIVITY_TIMEOUT_MS,
    onTimeout: handleInactivityTimeout,
  });

  const requestPasswordReset = useCallback(async (email: string): Promise<PasswordResetResult> => {
    try {
      await sendPasswordResetEmail(auth, email, passwordResetActionCodeSettings());
      return { ok: true };
    } catch (error) {
      const code = (error as AuthError).code;
      if (code === AuthErrorCodes.TOO_MANY_ATTEMPTS_TRY_LATER)
        return { ok: false, reason: 'too-many-requests' };
      // auth/user-not-found es un cas normal, no un error: no revelem si
      // l'email existeix o no al sistema (evita enumeració de comptes).
      if (code === AuthErrorCodes.USER_DELETED) return { ok: true };
      return { ok: false, reason: 'unknown' };
    }
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, login, logout, requestPasswordReset }),
    [user, isLoading, login, logout, requestPasswordReset],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {isWarning && <InactivityWarningBanner onContinue={resetTimer} />}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
