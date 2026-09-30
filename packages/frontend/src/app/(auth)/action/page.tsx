'use client';

import {
  AuthErrorCodes,
  confirmPasswordReset,
  verifyPasswordResetCode,
  type AuthError,
} from 'firebase/auth';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { TextField } from '@/components/ui/TextField';
import { auth } from '@/lib/firebase';

// Confirmat contra el projecte Firebase real (validatePassword, capa de
// política de contrasenyes: enforcementState "ENFORCE", minPasswordLength
// 6, sense cap altre requisit — cap majúscula/número/símbol obligatori) —
// no és un valor assumit pel SDK, és la configuració real del projecte.
const MIN_PASSWORD_LENGTH = 6;

const INVALID_LINK_MESSAGE = 'Aquest enllaç ja no és vàlid o ha caducat.';
const UNSUPPORTED_MODE_MESSAGE = 'Aquest enllaç no és vàlid.';
const UNKNOWN_ERROR_MESSAGE = "No s'ha pogut canviar la contrasenya. Torna-ho a provar.";

type PageState =
  | { status: 'verifying' }
  | { status: 'invalid'; message: string }
  | { status: 'ready'; email: string };

export default function ActionPage() {
  return (
    // Mateix motiu que login/page.tsx: useSearchParams exigeix un límit de
    // Suspense (Next.js 16, App Router).
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = searchParams.get('mode');
  const oobCode = searchParams.get('oobCode');

  const [state, setState] = useState<PageState>({ status: 'verifying' });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // Aquesta mateixa pàgina és el destí genèric per a qualsevol action
    // code de Firebase (handleCodeInApp: true) — avui només restabliment
    // de contrasenya hi arriba, però no s'assumeix: un `mode` diferent
    // (verificació d'email, etc.) o un oobCode absent es tracten com a
    // enllaç no suportat, no com un cas de "codi caducat".
    if (mode !== 'resetPassword' || !oobCode) {
      // Sense oobCode vàlid no hi ha res a verificar contra l'API — no és
      // un valor derivable durant el render (depèn de query params que
      // arriben via un hook de Next, no d'una prop).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ status: 'invalid', message: UNSUPPORTED_MODE_MESSAGE });
      return;
    }

    let cancelled = false;
    verifyPasswordResetCode(auth, oobCode)
      .then((email) => {
        if (!cancelled) setState({ status: 'ready', email });
      })
      .catch(() => {
        // auth/invalid-action-code i auth/expired-action-code són els dos
        // casos reals (codi ja usat, o vençut) — mateix missatge per a
        // tots dos, no cal distingir-los de cara a l'usuari.
        if (!cancelled) setState({ status: 'invalid', message: INVALID_LINK_MESSAGE });
      });
    return () => {
      cancelled = true;
    };
  }, [mode, oobCode]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (state.status !== 'ready' || !oobCode) return;

    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldError(`La contrasenya ha de tenir com a mínim ${MIN_PASSWORD_LENGTH} caràcters.`);
      return;
    }
    if (password !== confirmPassword) {
      setFieldError('Les contrasenyes no coincideixen.');
      return;
    }

    setFieldError(null);
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await confirmPasswordReset(auth, oobCode, password);
      router.replace('/login?passwordReset=success');
    } catch (error) {
      const code = (error as AuthError).code;
      if (code === AuthErrorCodes.WEAK_PASSWORD) {
        // Xarxa de seguretat: si la política real (ver constant de dalt)
        // canviés algun dia del costat de Firebase sense tocar aquest
        // codi, el rebuig arriba igual — amb un missatge clar, no un
        // "error desconegut".
        setFieldError(`La contrasenya ha de tenir com a mínim ${MIN_PASSWORD_LENGTH} caràcters.`);
      } else if (
        code === AuthErrorCodes.EXPIRED_OOB_CODE ||
        code === AuthErrorCodes.INVALID_OOB_CODE
      ) {
        // Es pot vèncer just entre verifyPasswordResetCode i aquest submit
        // (l'usuari va trigar, o va fer servir el mateix enllaç dues
        // vegades en dues pestanyes) — mateix missatge que a l'entrada.
        setState({ status: 'invalid', message: INVALID_LINK_MESSAGE });
      } else {
        setSubmitError(UNKNOWN_ERROR_MESSAGE);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Nova contrasenya">
      {state.status === 'verifying' && <p className="mt-4 text-sm text-gray-500">Carregant...</p>}

      {state.status === 'invalid' && (
        <>
          <p className="mt-4 text-sm text-red-600">{state.message}</p>
          <Link
            href="/login"
            className="mt-4 inline-block text-sm font-medium text-ink hover:underline"
          >
            Tornar a l&apos;inici de sessió
          </Link>
        </>
      )}

      {state.status === 'ready' && (
        <>
          <p className="mt-1 text-sm text-gray-500">
            Estableix una nova contrasenya per a {state.email}.
          </p>
          <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
            <TextField
              label="Contrasenya nova"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <TextField
              label="Confirma la contrasenya"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
            {fieldError && <p className="text-sm text-red-600">{fieldError}</p>}
            {submitError && <p className="text-sm text-red-600">{submitError}</p>}
            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? 'Desant...' : 'Desar contrasenya'}
            </button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
