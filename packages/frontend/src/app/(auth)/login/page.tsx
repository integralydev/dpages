'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { TextField } from '@/components/ui/TextField';
import { INACTIVITY_LOGOUT_FLAG_KEY, useAuth } from '@/hooks/useAuth';
import { firstAllowedRouteForModules } from '@/lib/roles';

const INACTIVITY_LOGOUT_MESSAGE = 'Sessió tancada per inactivitat.';

// Mateix missatge sempre, tant si l'email existeix al sistema com si no
// (auth/user-not-found es tracta com un èxit a useAuth) — evita que aquest
// formulari es faci servir per comprovar quins emails estan donats d'alta.
const FORGOT_PASSWORD_SENT_MESSAGE =
  "Si l'email existeix al sistema, t'hem enviat un enllaç per restablir la contrasenya.";
const TOO_MANY_REQUESTS_MESSAGE =
  'Massa intents seguits. Espera uns minuts abans de tornar-ho a provar.';
const UNKNOWN_ERROR_MESSAGE = "No s'ha pogut enviar l'enllaç. Torna-ho a provar.";

export default function LoginPage() {
  return (
    // useSearchParams exigeix un límit de Suspense (Next.js 16, App Router) —
    // sense això next build falla; no hi ha cap fallback visible perquè és
    // un component client que renderitza a l'instant, no fa cap fetch previ.
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const { login, requestPasswordReset } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [passwordResetSuccess, setPasswordResetSuccess] = useState(false);
  const [inactivityLogout, setInactivityLogout] = useState(false);

  const [showForgotForm, setShowForgotForm] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [isSendingReset, setIsSendingReset] = useState(false);

  useEffect(() => {
    if (searchParams.get('passwordReset') !== 'success') return;
    // No es pot derivar directament de searchParams durant el render: el
    // router.replace() de la línia de sota buida el query param, i si el
    // missatge depengués només de searchParams desapareixeria en el mateix
    // instant en què s'esborra, abans que ningú el vegi. Cal una còpia a
    // state que sobrevisqui a la neteja de la URL.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPasswordResetSuccess(true);
    router.replace('/login');
  }, [searchParams, router]);

  // Marca de sessionStorage (no query param): la deixa useAuth.tsx just
  // abans de fer signOut() per inactivitat — es llegeix i s'esborra un cop
  // acá, no via query param, per evitar una carrera amb el router.replace("/login")
  // que ja fa AuthGuard sol quan `user` passa a null (li guanyaria la mà i
  // esborraria qualsevol query que haguéssim afegit nosaltres).
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(INACTIVITY_LOGOUT_FLAG_KEY) !== '1') return;
      window.sessionStorage.removeItem(INACTIVITY_LOGOUT_FLAG_KEY);
      // Ha de ser un efecte, no derivar-ho durant el render: `window` no
      // existeix en el pas de SSR de Next per a aquest component client, i
      // llegir-lo fora d'un efecte donaria un valor diferent entre el
      // render de servidor i el primer render de client (hidratació
      // trencada).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInactivityLogout(true);
    } catch {
      // Sense sessionStorage disponible: simplement no es mostra l'avís.
    }
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const result = await login(email, password);

    if (!result.ok) {
      setError(
        result.reason === 'inactive'
          ? "Aquest usuari està desactivat. Contacta amb l'administrador."
          : 'Email o contrasenya incorrectes.',
      );
      setIsSubmitting(false);
      return;
    }

    router.replace(firstAllowedRouteForModules(result.user.rol.modulsPermesos));
  }

  function openForgotForm() {
    setForgotEmail(email);
    setForgotMessage(null);
    setForgotError(null);
    setShowForgotForm(true);
  }

  async function handleForgotSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSendingReset(true);
    setForgotError(null);
    setForgotMessage(null);

    const result = await requestPasswordReset(forgotEmail);

    if (!result.ok && result.reason === 'too-many-requests') {
      setForgotError(TOO_MANY_REQUESTS_MESSAGE);
    } else if (!result.ok) {
      setForgotError(UNKNOWN_ERROR_MESSAGE);
    } else {
      setForgotMessage(FORGOT_PASSWORD_SENT_MESSAGE);
    }
    setIsSendingReset(false);
  }

  return (
    <AuthLayout title="Benvingut/da" subtitle="Inicia sessió per continuar.">
      {passwordResetSuccess && (
        <p className="mt-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Contrasenya establerta correctament. Ja pots iniciar sessió amb la teva nova contrasenya.
        </p>
      )}
      {inactivityLogout && (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {INACTIVITY_LOGOUT_MESSAGE}
        </p>
      )}

      {!showForgotForm ? (
        <>
          <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
            <TextField
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <TextField
              label="Contrasenya"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? 'Iniciant sessió...' : 'Iniciar sessió'}
            </button>
          </form>
          <button
            type="button"
            onClick={openForgotForm}
            className="mt-4 text-sm font-medium text-ink hover:underline"
          >
            Has oblidat la contrasenya?
          </button>
        </>
      ) : (
        <form onSubmit={handleForgotSubmit} className="mt-6 flex flex-col gap-4">
          <p className="text-sm text-gray-500">
            Introdueix el teu email i t&apos;enviarem un enllaç per restablir la contrasenya.
          </p>
          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            value={forgotEmail}
            onChange={(event) => setForgotEmail(event.target.value)}
            required
            disabled={forgotMessage !== null}
          />
          {forgotMessage && (
            <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              {forgotMessage}
            </p>
          )}
          {forgotError && <p className="text-sm text-red-600">{forgotError}</p>}
          {!forgotMessage && (
            <button
              type="submit"
              disabled={isSendingReset}
              className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSendingReset ? 'Enviant...' : 'Enviar enllaç'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowForgotForm(false)}
            className="text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            Tornar a l&apos;inici de sessió
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
