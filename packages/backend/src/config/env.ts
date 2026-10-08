import { z } from 'zod';

/**
 * Fuera de producción, WC_BASE_URL sólo puede apuntar a un host de prueba —
 * nunca a dpages.cat real. Esto no es una preferencia de estilo: hubo dos
 * pruebas manuales que casi (y una vez sí) pegaron contra el WooCommerce real
 * del cliente con credenciales de prueba. La guarda vive acá, en el arranque
 * del proceso, para que el error sea imposible de cometer (el proceso ni
 * arranca) en vez de sólo improbable (acordarse de revisar la variable a
 * mano cada vez).
 */
const SUFIJOS_HOST_DE_PRUEBA = ['.invalid', '.test'];

function esHostDePrueba(hostname: string): boolean {
  return (
    hostname === 'localhost' || SUFIJOS_HOST_DE_PRUEBA.some((sufijo) => hostname.endsWith(sufijo))
  );
}

/**
 * DATABASE_URL tiene que aceptar tanto la cadena de Docker local
 * (postgres://usuario:pass@localhost:5433/dpages) como la de Cloud SQL, que
 * usa un socket unix vía query string y no siempre trae host entre "@" y "/"
 * (postgresql://usuario:pass@/dpages?host=/cloudsql/proyecto:region:instancia).
 * Por eso se valida como cadena con el prefijo correcto, no con z.string().url()
 * (el parser WHATWG de URL rechaza la forma de Cloud SQL por tener host vacío).
 */
const esquemaEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string({ required_error: 'falta esta variable de entorno' })
      .min(1, 'no puede estar vacía')
      .regex(/^postgres(ql)?:\/\//, 'debe empezar con postgres:// o postgresql://'),
    // Cloud Run escala instancias y cada una abre su propio pool; Cloud SQL en
    // instancias chicas tiene pocas conexiones disponibles. Techo bajo a propósito.
    DB_POOL_MAX: z.coerce.number().int().positive().max(20).default(5),

    // API REST v3 de WooCommerce (ADR-001) — /wp-json/wc/v3/, nunca la legacy.
    // Credencial de SÓLO LECTURA (ver docs/hallazgos-woocommerce.md).
    WC_BASE_URL: z
      .string({ required_error: 'falta esta variable de entorno' })
      .url('debe ser una URL válida, ej. https://dpages.cat'),
    WC_CONSUMER_KEY: z
      .string({ required_error: 'falta esta variable de entorno' })
      .min(1, 'no puede estar vacía'),
    WC_CONSUMER_SECRET: z
      .string({ required_error: 'falta esta variable de entorno' })
      .min(1, 'no puede estar vacía'),

    // Secreto del webhook de WooCommerce (WooCommerce → Ajustes → Avanzado →
    // Webhooks). Firma HMAC-SHA256 sobre el cuerpo crudo, ver ADR-009/016.
    WEBHOOK_SECRET: z
      .string({ required_error: 'falta esta variable de entorno' })
      .min(1, 'no puede estar vacía'),

    // Endpoint de tareas (ADR-009): secreto compartido para autenticar en
    // local/desarrollo. En producción se valida OIDC de Cloud Scheduler en su
    // lugar (ver TASQUES_OIDC_AUDIENCE) — este secreto igual tiene que existir
    // porque es el único mecanismo hasta que haya una revisión de Cloud Run.
    TASQUES_SECRET: z
      .string({ required_error: 'falta esta variable de entorno' })
      .min(1, 'no puede estar vacía'),
    // Audiencia esperada del token OIDC que manda Cloud Scheduler — típicamente
    // la URL del propio endpoint en Cloud Run. Opcional: todavía no hay URL de
    // producción definitiva (ver infra/gcp/README.md). Sin esto configurado,
    // el entorno de producción rechaza toda tarea en vez de aceptar sin validar.
    TASQUES_OIDC_AUDIENCE: z.string().url('debe ser una URL válida').optional(),

    // ADR-017: la primera ingesta de un recurso (sin cursor_sincronitzacio
    // previo) se acota a estos días hacia atrás en vez de traer el histórico
    // completo — evita una carga de miles de registros sin que nadie la
    // pidiera. Sólo afecta a la carga inicial; el incremental normal
    // (modified_after por cursor) no usa esta variable para nada.
    INGESTA_DIES_ENRERE_DEFECTE: z.coerce.number().int().positive().default(30),
    // Caso deliberado y poco frecuente: migrar el histórico completo de
    // verdad (ver P-21 del backlog). "true" explícito, cualquier otro valor
    // (incluido no definirla) es "false" — para que haga falta un cambio a
    // propósito, no un olvido, antes de traer miles de registros de nuevo.
    INGESTA_HISTORIC_COMPLET: z
      .string()
      .optional()
      .transform((valor) => valor === 'true'),

    // Piso de fecha de creación para pedidos de WooCommerce: ningún pedido
    // CREADO antes de esta fecha se trae ni se transforma, aunque se
    // modifique después en la tienda (ver transform/comandes.ts). Opcional
    // SIEMPRE acá (incluso en producción) a propósito: si faltara, NO
    // queremos que el proceso ni arranque por esto — eso bloquearía TODO el
    // backend por una variable que sólo afecta a la sincronización de
    // pedidos. En su lugar, transformarComanda valida su presencia en
    // tiempo de ejecución (falla cerrado, nunca crea un pedido sin este
    // control si NODE_ENV=production y la variable falta). Fuera de
    // producción, su ausencia es simplemente "sin piso" (comportamiento
    // actual, sin romper tests/desarrollo). ISO 8601 con zona siempre
    // (ej. "2026-10-08T07:00:00Z") — mismo criterio que TASQUES_OIDC_AUDIENCE
    // de arriba, que tampoco es obligatoria acá.
    INGESTA_COMANDES_DES_DE: z
      .string()
      .datetime({ message: 'debe ser ISO 8601 con zona, ej. 2026-10-08T07:00:00Z' })
      .optional(),

    // ADR-021: capa de negocio requiere Firebase Auth (contrato, sección 2).
    // Fuera de producción se puede saltear con este interruptor explícito —
    // "true" literal, cualquier otro valor (incluido no definirla) exige
    // token siempre, incluso en desarrollo. Mismo criterio que la guarda de
    // WC_BASE_URL: el caso seguro es el default, el bypass es opt-in.
    AUTH_DISABLED: z
      .string()
      .optional()
      .transform((valor) => valor === 'true'),

    // Origen permitido de CORS en producción (ver http/cors.ts) — fuera de
    // producción se usa un valor fijo de desarrollo, esta variable no aplica.
    // Opcional a propósito: si falta en producción, CORS queda cerrado
    // (ninguna petición cross-origin pasa), no abierto a cualquiera.
    CORS_ORIGIN: z.string().url('debe ser una URL válida, ej. https://app.dpages.cat').optional(),

    // LEGACY (I1, migración en curso) — usada por POST /usuaris (crear/borrar
    // usuario de Firebase, generar el link de establecimiento de contraseña).
    // Mecanismo de transición: mientras el rol IAM "Administrador de Firebase
    // Authentication" de Identity Toolkit no esté otorgado a la cuenta de
    // servicio de Cloud Run (dpages-backend@...), esta variable, si está
    // presente, tiene prioridad sobre Application Default Credentials (ver
    // obtenerAppFirebaseAdmin en auth-firebase.ts) — permite seguir operando
    // con la clave explícita del service account que Firebase genera
    // automáticamente (firebase-adminsdk-fbsvc@..., la única que hoy tiene
    // ese rol aplicado de verdad). Una vez que el rol se confirme también
    // para dpages-backend@..., esta variable puede quitarse de producción sin
    // tocar código: su ausencia hace que se use ADC directamente, mismo
    // mecanismo que ya usa la verificación de tokens (obtenerAppFirebase()).
    // Contenido COMPLETO del JSON de la cuenta de servicio (no una ruta de
    // archivo, no hay volúmenes montados en Cloud Run). Opcional acá a
    // propósito: la ausencia se resuelve perezosamente (cae a ADC), no al
    // arrancar el proceso.
    FIREBASE_ADMIN_SDK_KEY_JSON: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      // Imposible arrancar en producción con la autenticación apagada —
      // ni por una variable copiada de otro entorno ni por un descuido.
      if (data.AUTH_DISABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_DISABLED'],
          message:
            'no puede ser "true" con NODE_ENV=production — la autenticación ' +
            'de Firebase es obligatoria en producción, sin excepción.',
        });
      }
      return;
    }

    // Si WC_BASE_URL ya venía mal formada, ese error lo reporta el `.url()`
    // de más arriba — acá simplemente no hay nada más que chequear.
    let hostname: string;
    try {
      hostname = new URL(data.WC_BASE_URL).hostname;
    } catch {
      return;
    }

    if (!esHostDePrueba(hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WC_BASE_URL'],
        message:
          `fuera de NODE_ENV=production sólo se permite un host de prueba ` +
          `(localhost, *.invalid, *.test) — recibido "${hostname}". No es una ` +
          `URL real de WooCommerce, aunque lo sea: esta guarda existe para que ` +
          `una prueba manual no pueda pegarle por accidente a dpages.cat.`,
      });
    }
  });

export type Env = z.infer<typeof esquemaEnv>;

export class ErrorConfiguracion extends Error {}

/**
 * Función pura, sin efectos: separada de `env` para poder testear los casos
 * de error sin pasar por process.exit(). El arranque real usa `env` (abajo).
 */
export function parsearEnv(entorno: Record<string, string | undefined>): Env {
  const resultado = esquemaEnv.safeParse(entorno);

  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((issue) => {
        const variable = issue.path.join('.') || '(variable desconocida)';
        return `  · ${variable}: ${issue.message}`;
      })
      .join('\n');

    throw new ErrorConfiguracion(
      `Configuración inválida — el proceso no puede arrancar:\n${detalle}\n\n` +
        'Revisá .env.example para ver qué variables hacen falta y con qué formato.',
    );
  }

  return resultado.data;
}

function inicializarEnv(): Env {
  try {
    return parsearEnv(process.env);
  } catch (err) {
    if (err instanceof ErrorConfiguracion) {
      // Fallar acá, en el arranque del módulo, es la parte importante: si
      // falta una variable el proceso no llega a levantar el servidor ni a
      // aceptar la primera petición.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

export const env = inicializarEnv();
