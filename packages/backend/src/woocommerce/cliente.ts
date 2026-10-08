import { setTimeout as esperar } from 'node:timers/promises';
import { inspect } from 'node:util';
import type { WooOrder, WooProduct, WooProductVariation } from '@dpages/shared';
import { Agent, setGlobalDispatcher } from 'undici';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Cliente de SÓLO LECTURA para la API REST v3 de WooCommerce (ADR-001:
 * /wp-json/wc/v3/, nunca la legacy). Estructuralmente de sólo lectura: acá
 * abajo no hay ningún parámetro de método HTTP en ningún punto del módulo,
 * así que no existe forma de construir un POST/PUT/DELETE aunque alguien
 * quisiera — la única función de bajo nivel (`peticionGet`) siempre hace GET.
 *
 * Las seis reglas obligatorias de consulta (ver
 * docs/hallazgos-woocommerce.md y el agente woocommerce-integration) se
 * aplican todas acá, una sola vez: un recurso nuevo las hereda sin que
 * nadie tenga que acordarse de repetirlas.
 */

// Incidente real de producción (ver docs/hallazgos-woocommerce.md):
// PER_PAGE=100 dejaba páginas reales (con line items/meta por pedido) más
// pesadas de lo necesario en el hosting real de dpages.cat. Bajado a 30
// (peticiones más chicas y rápidas) — el problema real resultó estar en
// los timeouts, no acá.
const PER_PAGE = 30;

/**
 * REINTENTOS_MAXIMOS=2 (ver docs/hallazgos-woocommerce.md para el detalle
 * completo). Con 5 reintentos, una sola página que falla los 6 intentos
 * completos consume
 * casi todo el presupuesto de Cloud Run (300s) ella sola — confirmado con
 * un caso real: 6 × 45s + 15,5s de backoff = 285,5s calculados contra
 * 285.568ms observados. Con más de una página fallando así, el request
 * completo excede los 300s inevitablemente, sin importar qué tan generosos
 * sean los timeouts individuales. Menos reintentos = falla rápido = deja
 * presupuesto para las páginas que sí funcionan — y el reintento "real"
 * no es este, es el próximo disparo de Cloud Scheduler 5 minutos después
 * (ADR-009: los endpoints de tarea son idempotentes entre corridas). Los
 * reintentos de acá adentro son una defensa contra baches cortos de
 * milisegundos/segundos, no contra degradación sostenida de varios
 * minutos — para eso ya existe el próximo disparo del scheduler.
 */
const REINTENTOS_MAXIMOS = 2;
const ESPERA_BASE_MS = 500;
const ESPERA_MAXIMA_MS = 10_000;

/**
 * El error de fondo detrás de "fetch failed" resultó ser un
 * `ConnectTimeoutError` de undici a los 10_000ms — el `connectTimeout` POR
 * DEFECTO de undici, que `AbortSignal.timeout()` NO controla (son dos
 * mecanismos independientes: el AbortSignal cubre toda la petición desde
 * que se llama a `fetch`, pero undici corta la fase de CONEXIÓN por su
 * cuenta antes de que el AbortSignal tenga oportunidad de intervenir).
 *
 * ADVERTENCIA — NO usar el MISMO valor para las dos cosas: con
 * connectTimeout y AbortSignal corriendo la misma carrera, cuál de los dos
 * dispara primero ante una conexión colgada pasa a depender de detalles
 * internos de scheduling de Node, no de en qué fase falló de verdad —
 * rompiendo la capacidad de diagnóstico que da capturar `err.cause` (ya
 * pasó: en producción volvió a aparecer el mensaje genérico del
 * AbortSignal, no ConnectTimeoutError, sin que eso implicara que el
 * problema hubiera cambiado de fase). TIMEOUT_CONEXIO_MS es un valor
 * propio y MENOR que TIMEOUT_PETICION_MS — la fase de conectar (TCP/TLS)
 * no debería competir por el mismo presupuesto que la espera de una
 * respuesta completa. TIMEOUT_PETICION_MS=30s: la evidencia real (pruebas
 * manuales aisladas) nunca mostró más de ~24s en el peor caso — 45s no
 * aportaba margen real, sólo alargaba cada intento fallido innecesariamente.
 */
const TIMEOUT_CONEXIO_MS = 15_000;
const TIMEOUT_PETICION_MS = 30_000;

/**
 * `setGlobalDispatcher` afecta también al fetch NATIVO de Node (comparten
 * el dispatcher global por diseño de undici), no sólo a llamadas hechas
 * directamente con este paquete — no hace falta (ni se puede) pasarlo por
 * `peticionGet`. Se corre una sola vez, al cargar este módulo — este es el
 * único módulo del backend que usa `fetch` (ver comentario de cabecera),
 * así que mutar el dispatcher global acá no interfiere con ningún otro
 * caller hoy.
 */
setGlobalDispatcher(new Agent({ connectTimeout: TIMEOUT_CONEXIO_MS }));

/**
 * dates_are_gmt, orderby, order y per_page: van último en la URL para que
 * ningún parámetro del llamador los pueda pisar. status=any es una regla
 * más, pero sólo aplica a /orders — no es universal, así que vive en
 * `listarPedidos`, no acá.
 */
const PARAMS_OBLIGATORIOS = {
  dates_are_gmt: 'true',
  orderby: 'modified',
  order: 'asc',
  per_page: String(PER_PAGE),
} as const;

export class ErrorWooCommerce extends Error {
  constructor(
    public readonly recurso: string,
    public readonly status: number | null,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorWooCommerce';
  }
}

/**
 * dpages.cat descarta el header `Authorization` antes de que llegue a
 * WordPress (confirmado con curl directo: el header da 401, el
 * mismo par de credenciales por query string da 200). WooCommerce/WordPress
 * soportan las dos formas oficialmente (REST API Handbook), así que esto
 * no es un workaround frágil — es simplemente el mecanismo que el
 * servidor real de este cliente sí deja pasar. Van en la MISMA posición
 * que `PARAMS_OBLIGATORIOS` (spread al final de `construirUrl`) para que
 * ningún parámetro del llamador los pueda pisar.
 */
function credencialsWoo(): Record<string, string> {
  return {
    consumer_key: env.WC_CONSUMER_KEY,
    consumer_secret: env.WC_CONSUMER_SECRET,
  };
}

/**
 * Red de seguridad — no la única barrera, pero sí obligatoria: desde que
 * las credenciales viajan en el query string, cualquier texto
 * que las contenga y termine en un log, o en una columna de auditoría
 * (`esdeveniment_webhook.error` en webhook.ts,
 * `cursor_sincronitzacio.ultim_error` en sync/ingesta.ts — ambos guardan
 * tal cual el `.message` de lo que este módulo termina lanzando), las
 * expondría en texto plano. El único punto real de riesgo en todo el
 * módulo es más abajo (el mensaje de un `fetch` fallido, que Node/undici
 * arma con contenido que no controlamos) — se redacta el query string
 * COMPLETO ahí, no sólo `consumer_key`/`consumer_secret`: más simple y más
 * seguro que aislar por nombre de parámetro (un error de regex ahí sería
 * exactamente el tipo de bug que termina filtrando credenciales). El resto
 * del mensaje (qué recurso, cuántos reintentos) se conserva — no hace
 * falta perder todo el diagnóstico para no filtrar el secreto. Sanitizar
 * en ESTE único punto (no en cada `catch` de webhook.ts/ingesta.ts) alcanza
 * porque este módulo es el único lugar de todo el backend que llama
 * `fetch` — cualquier error relacionado con WooCommerce pasa por acá.
 */
function redactarUrlEnTexto(texto: string): string {
  return texto.replace(/\?\S*/g, '?[redactat]');
}

/**
 * "fetch failed" es el mensaje genérico que usa undici para fallos de
 * conexión de bajo nivel (reset, DNS, TLS, socket cerrado del otro lado) —
 * el motivo real queda en `err.cause`. Sin esto, no hay forma de
 * distinguir en los logs "se disparó nuestro AbortSignal" de "algo cortó
 * la conexión del otro lado". `undefined` si no hay causa (la mayoría de
 * los errores no la tienen) — no se agrega nada a los logs ni al mensaje
 * en ese caso. Redactada igual que el mensaje principal: la causa también
 * puede traer texto armado por Node/undici que no controlamos.
 *
 * `err.cause` no está garantizado a ser un `Error` — puede ser cualquier
 * valor (spec de `Error.cause`). Si es un `Error`, usamos `.message` (corto
 * y limpio, sin stack). Si NO lo es, `String(valor)` convertiría cualquier
 * objeto plano en el string literal `"[object Object]"` — inútil para
 * diagnosticar, y exactamente el tipo de cosa que esta función existe para
 * evitar. `util.inspect()` nunca tira ("[object Object]" ni excepciones,
 * incluso con referencias circulares) y muestra la forma real del valor.
 */
function obtenerCausaComoTexto(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.cause === undefined) return undefined;
  const texto = err.cause instanceof Error ? err.cause.message : inspect(err.cause, { depth: 2 });
  return redactarUrlEnTexto(texto);
}

function construirUrl(recurso: string, params: Record<string, string>): URL {
  const base = env.WC_BASE_URL.replace(/\/+$/, '') + '/wp-json/wc/v3/';
  const url = new URL(recurso, base);
  for (const [clave, valor] of Object.entries({
    ...params,
    ...PARAMS_OBLIGATORIOS,
    ...credencialsWoo(),
  })) {
    url.searchParams.set(clave, valor);
  }
  return url;
}

function esReintentable(status: number): boolean {
  return status === 429 || status >= 500;
}

function calcularEspera(intento: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const segundos = Number(retryAfter);
    if (Number.isFinite(segundos) && segundos >= 0) {
      return Math.min(segundos * 1000, ESPERA_MAXIMA_MS);
    }
  }
  return Math.min(ESPERA_BASE_MS * 2 ** (intento - 1), ESPERA_MAXIMA_MS);
}

/**
 * Única función que llama a fetch en todo el módulo, y siempre sin
 * `method` (GET implícito). Reintenta con espera creciente ante 429/5xx y
 * ante fallos de red, hasta REINTENTOS_MAXIMOS veces. El error final nunca
 * incluye el cuerpo de la respuesta — puede traer datos personales de
 * clientes reales.
 */
async function peticionGet(recurso: string, params: Record<string, string>): Promise<Response> {
  const url = construirUrl(recurso, params);

  for (let intento = 1; intento <= REINTENTOS_MAXIMOS + 1; intento++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_PETICION_MS),
      });
    } catch (err) {
      const causa = obtenerCausaComoTexto(err);

      if (intento > REINTENTOS_MAXIMOS) {
        // redactarUrlEnTexto: err.message puede traer la URL completa —
        // con credenciales en el query string — armada por Node/undici, no
        // por este módulo. Ver la nota en la función.
        const mensaje = err instanceof Error ? err.message : String(err);
        throw new ErrorWooCommerce(
          recurso,
          null,
          `Sin respuesta de WooCommerce en "${recurso}" tras ${REINTENTOS_MAXIMOS} reintentos: ${redactarUrlEnTexto(mensaje)}` +
            (causa !== undefined ? ` (causa: ${causa})` : ''),
        );
      }
      logger.warn({ recurso, intento, causa }, 'Fallo de red hacia WooCommerce, reintentando');
      await esperar(calcularEspera(intento, null));
      continue;
    }

    if (esReintentable(res.status) && intento <= REINTENTOS_MAXIMOS) {
      logger.warn(
        { recurso, intento, status: res.status },
        'WooCommerce respondió con error reintentable',
      );
      await esperar(calcularEspera(intento, res.headers.get('retry-after')));
      continue;
    }

    if (!res.ok) {
      // Nunca el cuerpo: puede traer datos de negocio o personales.
      throw new ErrorWooCommerce(
        recurso,
        res.status,
        `WooCommerce respondió ${res.status} en "${recurso}"`,
      );
    }

    return res;
  }

  /* istanbul ignore next -- el for siempre retorna o lanza antes de esto */
  throw new ErrorWooCommerce(recurso, null, `No se pudo completar la petición a "${recurso}"`);
}

async function leerJson<T>(recurso: string, res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ErrorWooCommerce(
      recurso,
      res.status,
      `Respuesta de WooCommerce en "${recurso}" no es JSON válido (posible bloqueo de WAF/Cloudflare)`,
    );
  }
}

interface PaginaResultado<T> {
  datos: T[];
  totalPaginas: number | null;
}

async function obtenerPagina<T>(
  recurso: string,
  params: Record<string, string>,
  pagina: number,
): Promise<PaginaResultado<T>> {
  const res = await peticionGet(recurso, { ...params, page: String(pagina) });
  const datos = await leerJson<T[]>(recurso, res);

  if (!Array.isArray(datos)) {
    throw new ErrorWooCommerce(
      recurso,
      res.status,
      `Respuesta de WooCommerce en "${recurso}" no es una lista`,
    );
  }

  const cabeceraPaginas = res.headers.get('x-wp-totalpages');
  return {
    datos,
    totalPaginas: cabeceraPaginas !== null ? Number(cabeceraPaginas) : null,
  };
}

/** Pagina por X-WP-TotalPages (regla obligatoria) — nunca "hasta que venga vacío". */
async function listarTodo<T>(recurso: string, params: Record<string, string>): Promise<T[]> {
  const todo: T[] = [];
  let pagina = 1;

  while (true) {
    const { datos, totalPaginas } = await obtenerPagina<T>(recurso, params, pagina);
    todo.push(...datos);

    // Log de progreso EN CADA página, no sólo al final: una carga inicial
    // sin acotar puede traer miles de registros y tardar varios minutos —
    // sin esto no hay forma de distinguir "está trabajando" de "se colgó".
    logger.info(
      { recurso, pagina, totalPaginas, itemsAcumulados: todo.length },
      'Progreso de paginación de WooCommerce',
    );

    if (datos.length === 0) break;
    if (totalPaginas !== null) {
      if (pagina >= totalPaginas) break;
    } else if (datos.length < PER_PAGE) {
      break;
    }
    pagina++;
  }

  // Cantidad, nunca contenido — los pedidos traen nombres, emails, teléfonos,
  // direcciones y NIF de clientes reales (requisito RGPD, no preferencia).
  logger.info({ recurso, total: todo.length }, 'Recurso de WooCommerce listado completo');
  return todo;
}

export interface ParametrosListado {
  /** date_modified_gmt >= este valor (ISO 8601). Funciona en /orders y /products (verificado). */
  modifiedAfter?: string;
  /**
   * Piso de activación (sólo `/orders`, ver `ingerirComandes`): `after`
   * filtra por `date_created_gmt` — a diferencia de `modified_after`, que
   * filtra por `date_modified_gmt`. Sólo reduce lo que se trae de la tienda
   * (menos datos personales de pedidos viejos aterrizados sin necesidad);
   * NO es la barrera real — `transformarComanda` vuelve a comparar
   * `date_created_gmt` contra el mismo piso antes de crear nada, porque la
   * fiabilidad de `after`/`dates_are_gmt` del lado de WooCommerce no está
   * confirmada (`docs/hallazgos-woocommerce.md`).
   */
  createdAfter?: string;
}

function paramsOpcionales(params: ParametrosListado): Record<string, string> {
  return {
    ...(params.modifiedAfter ? { modified_after: params.modifiedAfter } : {}),
    ...(params.createdAfter ? { after: params.createdAfter } : {}),
  };
}

export async function listarPedidos(params: ParametrosListado = {}): Promise<WooOrder[]> {
  return listarTodo<WooOrder>('orders', {
    status: 'any', // captura cancelaciones — no lo puede pisar el llamador
    ...paramsOpcionales(params),
  });
}

/** GET /orders/{id} — usado por el webhook (ADR-002): notificación → estado canónico. */
export async function obtenerPedido(wooOrderId: number): Promise<WooOrder> {
  const res = await peticionGet(`orders/${wooOrderId}`, {});
  const pedido = await leerJson<WooOrder>('orders', res);
  logger.info({ wooOrderId }, 'Pedido obtenido de WooCommerce');
  return pedido;
}

export async function listarProductos(params: ParametrosListado = {}): Promise<WooProduct[]> {
  return listarTodo<WooProduct>('products', paramsOpcionales(params));
}

export async function listarVariaciones(wooProductId: number): Promise<WooProductVariation[]> {
  return listarTodo<WooProductVariation>(`products/${wooProductId}/variations`, {});
}
