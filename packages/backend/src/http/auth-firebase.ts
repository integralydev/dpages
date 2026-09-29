import type { App, ServiceAccount } from 'firebase-admin/app';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ORIGEN_DESENVOLUPAMENT } from './cors.js';
import { cosError } from './error-api.js';

/**
 * Se adjunta a `req.usuari` en toda ruta de negocio (contrato, sección 2).
 * `rol` viene de un custom claim de Firebase (`rol`, ej. "oficina") — el
 * cliente pidió que NINGÚN endpoint restrinja acceso por rol, así que esto
 * es sólo para auditoría (ver `comanda_linia.confirmat_per`), no para
 * autorización.
 */
export interface InfoUsuari {
  uid: string;
  rol: string | null;
  /** Claim `email` del token, si el proveedor lo trae — usado por el auto-provisioning en resoldre-usuari.ts. */
  email: string | null;
  /** Claim `name` del token (ej. Google Sign-In lo trae; email/password no). */
  nom: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    usuari?: InfoUsuari;
  }
}

/** Inyectable: en tests se reemplaza por un verificador simulado, nunca se llama a Firebase real. */
export type VerificadorToken = (token: string) => Promise<InfoUsuari | null>;

let appFirebase: App | null = null;

/**
 * Perezoso a propósito: si esto corriera al importar el módulo, cualquier
 * test que importe `servidor.ts` (todos, indirectamente) inicializaría el
 * SDK de Firebase aunque nunca vaya a usarlo — nada grave, pero es trabajo
 * de más y una dependencia de red innecesaria en el arranque. Recién se
 * llama la primera vez que `verificarTokenFirebase` verifica un token de
 * verdad, y en desarrollo/test eso no pasa nunca (`AUTH_DISABLED` o un
 * verificador inyectado lo evitan).
 */
async function obtenerAppFirebase(): Promise<App> {
  if (appFirebase !== null) return appFirebase;
  const { getApps, initializeApp } = await import('firebase-admin/app');
  const existentes = getApps();
  // Application Default Credentials: en Cloud Run, el service account de la
  // instancia ya alcanza — no hace falta ninguna variable de entorno nueva
  // (más allá de que el proyecto de Firebase exista). En local, hace falta
  // GOOGLE_APPLICATION_CREDENTIALS apuntando a una clave de servicio si
  // alguna vez se prueba con AUTH_DISABLED=false contra un proyecto real.
  appFirebase = existentes[0] ?? initializeApp();
  return appFirebase;
}

const NOM_APP_FIREBASE_ADMIN = 'admin-usuaris';

let appFirebaseAdmin: App | null = null;

/**
 * App de Firebase SEPARADA de `obtenerAppFirebase()`, sólo para las
 * operaciones de gestión de usuarios (`crearUsuari`, `esborrarUsuari`,
 * `generarLinkEstabliment`). NO la usa el middleware de autenticación
 * (`verificarTokenFirebase` sigue con `obtenerAppFirebase()` y credenciales
 * por defecto, sin cambios).
 *
 * Motivo de la app separada, histórico (I1): Identity Toolkit (el servicio
 * detrás de `createUser`/`generatePasswordResetLink`/`deleteUser`) gestiona
 * sus propios permisos por fuera de IAM de GCP — la cuenta de servicio de
 * Cloud Run (`dpages-backend@...`) nunca tuvo el rol "Administrador de
 * Firebase Authentication" aplicado ahí, pese a sus roles de IAM a nivel de
 * proyecto. Por eso originalmente esta app usaba SIEMPRE una clave de
 * servicio explícita (`credential.cert`, la del service account que Firebase
 * genera automáticamente, `firebase-adminsdk-fbsvc@...`, que sí tenía ese rol).
 *
 * Migración a ADC (I1, en curso): una vez que el rol se le otorgue TAMBIÉN a
 * la cuenta de servicio de Cloud Run, Application Default Credentials
 * (`initializeApp()` sin argumentos, mismo mecanismo que `obtenerAppFirebase()`)
 * alcanza para esto también, sin necesitar ninguna clave pegada en una
 * variable de entorno. Mientras ese rol no esté confirmado en producción,
 * `FIREBASE_ADMIN_SDK_KEY_JSON` sigue funcionando como mecanismo explícito:
 * si está configurada, tiene prioridad (permite no depender de que el IAM ya
 * esté otorgado); si no está, se cae a ADC. Verificado localmente (llamada
 * real de sólo lectura a Identity Toolkit, `listUsers`) que ADC funciona
 * igual de bien que `cert()` cuando la cuenta detrás de las credenciales
 * tiene el rol — la única cuenta que hoy lo tiene es
 * `firebase-adminsdk-fbsvc@...`, la misma que ya usa `GOOGLE_APPLICATION_CREDENTIALS`
 * en local (ver `.env.example`). En Cloud Run, ADC resuelve a
 * `dpages-backend@...`, que TODAVÍA no tiene el rol — hasta que se confirme,
 * producción sigue necesitando `FIREBASE_ADMIN_SDK_KEY_JSON` configurada.
 *
 * El Admin SDK permite varias apps nombradas en el mismo proceso, así que
 * esto no interfiere con la app por defecto (`obtenerAppFirebase()`).
 *
 * Perezoso, mismo criterio que `obtenerAppFirebase()`: no depende de ninguna
 * variable al arrancar el proceso — recién se resuelve cuando alguien
 * efectivamente llama a `POST /usuaris`.
 */
async function obtenerAppFirebaseAdmin(): Promise<App> {
  if (appFirebaseAdmin !== null) return appFirebaseAdmin;

  const { getApps, initializeApp, cert } = await import('firebase-admin/app');
  const existente = getApps().find((app) => app.name === NOM_APP_FIREBASE_ADMIN);
  if (existente) {
    appFirebaseAdmin = existente;
    return appFirebaseAdmin;
  }

  // FIREBASE_ADMIN_SDK_KEY_JSON, si está presente, tiene prioridad sobre ADC
  // — mecanismo legacy/explícito para no depender de que el rol IAM de
  // Identity Toolkit ya esté otorgado a la cuenta de servicio de la
  // instancia (ver comentario de arriba). Ausente: se usa ADC, igual que
  // `obtenerAppFirebase()`.
  if (env.FIREBASE_ADMIN_SDK_KEY_JSON) {
    const credencial = JSON.parse(env.FIREBASE_ADMIN_SDK_KEY_JSON) as ServiceAccount;
    appFirebaseAdmin = initializeApp({ credential: cert(credencial) }, NOM_APP_FIREBASE_ADMIN);
    return appFirebaseAdmin;
  }

  appFirebaseAdmin = initializeApp({}, NOM_APP_FIREBASE_ADMIN);
  return appFirebaseAdmin;
}

/**
 * Implementación real — nunca se ejecuta en los tests de este repo (se
 * inyecta un `VerificadorToken` simulado en su lugar, o `AUTH_DISABLED` la
 * evita entera). `verifyIdToken` ya valida firma, expiración, `aud`/`iss`
 * contra el proyecto de Firebase — no hay nada más que chequear acá.
 */
export const verificarTokenFirebase: VerificadorToken = async (token) => {
  try {
    const { getAuth } = await import('firebase-admin/auth');
    const app = await obtenerAppFirebase();
    const decodificado = await getAuth(app).verifyIdToken(token);
    const rol = typeof decodificado.rol === 'string' ? decodificado.rol : null;
    const email = typeof decodificado.email === 'string' ? decodificado.email : null;
    const nom = typeof decodificado.name === 'string' ? decodificado.name : null;
    return { uid: decodificado.uid, rol, email, nom };
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Token de Firebase inválido o expirado',
    );
    return null;
  }
};

function extraerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/**
 * Alta manual de usuarios (`POST /api/v1/usuaris`) — operaciones de
 * administración sobre Firebase Auth, distintas de verificar un token.
 * Inyectable (mismo criterio que `VerificadorToken`): en los tests se
 * reemplaza por un mock con `vi.fn()`, nunca se llama a Firebase real.
 */
export interface GestioUsuarisFirebase {
  /** Crea el usuario en Firebase con una contraseña aleatoria descartable — nunca la usa, establece la suya vía `generarLinkEstabliment`. */
  crearUsuari(email: string): Promise<{ uid: string }>;
  /** Revierte `crearUsuari` — usado cuando algo falla DESPUÉS de crear en Firebase (ver usuaris.ts), para no dejar un usuario huérfano allá. */
  esborrarUsuari(uid: string): Promise<void>;
  /** Link de un solo uso para que la persona establezca su propia contraseña — no hay envío de email automático, lo comparte el Administrador a mano. */
  generarLinkEstabliment(email: string): Promise<string>;
}

/**
 * Mismo criterio de entorno que `opcionsCors()` en cors.ts: fuera de
 * producción, el origen fijo de
 * desarrollo; en producción, `env.CORS_ORIGIN`. A diferencia de CORS (que
 * si falta simplemente cierra el acceso, `origin: false`), acá NO hay un
 * fallback seguro posible — sin origen no hay URL que construir, así que
 * falla explícito en el momento de generar el link, nunca con un
 * `undefined`/string vacío incrustado en la URL en silencio.
 *
 * Exportada para poder testear la construcción de la URL sin pasar por
 * Firebase real (`generarLinkEstabliment` de abajo nunca corre en los
 * tests de este repo).
 */
export function construirActionCodeSettingsEstabliment(): {
  url: string;
  handleCodeInApp: boolean;
} {
  const origen = env.NODE_ENV === 'production' ? env.CORS_ORIGIN : ORIGEN_DESENVOLUPAMENT;
  if (!origen) {
    throw new Error(
      'CORS_ORIGIN no està configurada en producció — no es pot generar el link ' +
        "d'establiment de contrasenya sense saber a quin origen ha d'apuntar.",
    );
  }
  return {
    // Los 3 flujos de contraseña (reset, verificación, alta) los maneja una
    // pantalla propia en `/action`, no la pantalla genérica de Firebase.
    // Los otros 2 flujos (controlados directo por el frontend) ya apuntaban
    // ahí — esto hace que el link de alta de usuario (POST /usuaris) sea
    // consistente con ellos.
    url: `${origen}/action`,
    // Obligatorio pasarlo explícito a `generatePasswordResetLink` — el
    // riesgo real es OMITIR este campo (dejarlo `undefined`), no el valor
    // que lleve: sin él, el Admin SDK intenta generar un link corto vía
    // Firebase Dynamic Links, que Google dio de baja — la llamada queda
    // colgada esperando una respuesta que nunca llega, sin lanzar error.
    // `true` porque hay una pantalla propia en `/action` que maneja el
    // código de acción dentro de la propia app — no hace falta que Firebase
    // arme su propia pantalla ni un deep link a una app móvil (que tampoco
    // existe). Lo que importa para evitar el bug es que el campo siga
    // siempre explícito, nunca ausente.
    handleCodeInApp: true,
  };
}

/** Implementación real — nunca se ejecuta en los tests de este repo (se inyecta un mock en su lugar). */
export const gestioUsuarisFirebase: GestioUsuarisFirebase = {
  async crearUsuari(email) {
    const { getAuth } = await import('firebase-admin/auth');
    const app = await obtenerAppFirebaseAdmin();
    // Contraseña descartable: cumple el mínimo de Firebase (6 caracteres),
    // nadie la conoce ni la necesita — la persona establece la suya propia
    // a través de generarLinkEstabliment.
    const { randomUUID } = await import('node:crypto');
    const userRecord = await getAuth(app).createUser({ email, password: randomUUID() });
    return { uid: userRecord.uid };
  },
  async esborrarUsuari(uid) {
    const { getAuth } = await import('firebase-admin/auth');
    const app = await obtenerAppFirebaseAdmin();
    await getAuth(app).deleteUser(uid);
  },
  async generarLinkEstabliment(email) {
    const { getAuth } = await import('firebase-admin/auth');
    const app = await obtenerAppFirebaseAdmin();
    return getAuth(app).generatePasswordResetLink(email, construirActionCodeSettingsEstabliment());
  },
};

/**
 * `preHandler` de Fastify para las rutas de negocio (contrato, sección 2).
 * `/salut`, `/webhooks/woocommerce` y `/tasques/*` NO pasan por acá — viven
 * fuera del scope de plugin donde se registra este hook (ver servidor.ts),
 * tienen su propio mecanismo (HMAC / OIDC-secreto compartido).
 *
 * El bypass de desarrollo (`AUTH_DISABLED=true`) sólo es posible fuera de
 * producción — ver la guarda en config/env.ts, que hace imposible arrancar
 * el proceso con `AUTH_DISABLED=true` y `NODE_ENV=production` a la vez.
 */
export function crearMiddlewareAuth(verificador: VerificadorToken = verificarTokenFirebase) {
  return async function middlewareAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (env.NODE_ENV !== 'production' && env.AUTH_DISABLED) {
      req.usuari = { uid: 'dev-sense-auth', rol: null, email: null, nom: null };
      return;
    }

    const token = extraerToken(req.headers.authorization);
    if (token === undefined) {
      reply.code(401).send(cosError('NO_AUTENTICAT', 'No autoritzat'));
      return;
    }

    const usuari = await verificador(token);
    if (usuari === null) {
      reply.code(401).send(cosError('NO_AUTENTICAT', 'No autoritzat'));
      return;
    }

    req.usuari = usuari;
  };
}
