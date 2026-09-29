import type { Paginacio } from '@dpages/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DatabaseError } from 'pg';
import type { Pool } from 'pg';
import { cosError } from '../../error-api.js';

export const MIDA_PAGINA_DEFECTE = 50;
export const MIDA_PAGINA_MAXIMA = 200;

export interface OpcionsPaginacio {
  pagina: number;
  mida: number;
  offset: number;
}

/** `?pagina=1&mida=50` (contrato, sección 2) — mida entre 1 y 200, default 50; pagina mínima 1. */
export function parsearPaginacio(query: Record<string, unknown>): OpcionsPaginacio {
  const pagina = Math.max(1, Math.trunc(Number(query.pagina)) || 1);
  const midaBruta = Math.trunc(Number(query.mida)) || MIDA_PAGINA_DEFECTE;
  const mida = Math.min(MIDA_PAGINA_MAXIMA, Math.max(1, midaBruta));
  return { pagina, mida, offset: (pagina - 1) * mida };
}

export function construirPaginacio(pagina: number, mida: number, total: number): Paginacio {
  return { pagina, mida, total, totalPagines: Math.ceil(total / mida) };
}

/**
 * ISO-8601 UTC con "Z" (contrato, sección 2) — `Date.toISOString()` ya lo
 * hace, salvo que incluye milisegundos, que el contrato no pide
 * (`"2026-08-15T09:30:00Z"`, no `"...T09:30:00.000Z"`).
 */
export function formatearDataApi(data: Date | string | null | undefined): string | null {
  if (data === null || data === undefined) return null;
  const fecha = data instanceof Date ? data : new Date(data);
  return fecha.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Fragmento SQL para el extremo superior de un filtro `...Fins` de fecha,
 * que INCLUYE el día completo. Riesgo real: `columna <= $n` con
 * `$n = "2026-08-28"` se interpreta como `2026-08-28T00:00:00Z` (medianoche
 * del INICIO de ese día), no su final — corta afuera cualquier registro con
 * hora real dentro del mismo día.
 *
 * El fix trata el límite como EXCLUSIVO contra el día siguiente en vez de
 * `<=` contra el valor tal cual — `$n::date` descarta cualquier hora que
 * venga en `$n` (si alguna vez llega un timestamp completo en vez de sólo
 * fecha, el comportamiento es el mismo: día completo, no una hora exacta —
 * es la semántica correcta para un filtro que se documenta como "fecha",
 * `format: date` en el contrato, nunca `date-time`).
 *
 * Los `...Des` NO tienen este problema y NO se tocan: `columna >= $n` con
 * `$n` a medianoche del día de inicio ya incluye el día completo desde su
 * comienzo, que es el comportamiento correcto.
 */
export function condicioDataFinsInclusiva(columna: string, index: number): string {
  return `${columna} < ($${index}::date + interval '1 day')`;
}

/**
 * `comanda_linia.unitats_demanades`/`unitats_lliurades` son NUMERIC(10,2)
 * (entregas/pedidos parciales de pieza: 2.5 unidades cuando no se produjo
 * la pieza completa, migración 0016). Válido: mayor que cero, como máximo
 * 2 decimales — no hay Zod schemas acá (sólo en `config/env.ts`), la
 * validación de estos 4 puntos de entrada (`POST /comandes`,
 * `POST .../linies`, `PATCH .../linies/:liniaId`, `PATCH .../lliurament`)
 * siempre es manual.
 *
 * La comparación de punto flotante es segura para este caso: los valores
 * que fallarían por imprecisión son justamente los que tienen MÁS de 2
 * decimales reales, que es exactamente lo que se quiere rechazar.
 */
export function esUnitatsValides(valor: unknown): valor is number {
  return (
    typeof valor === 'number' &&
    Number.isFinite(valor) &&
    valor > 0 &&
    Math.round(valor * 100) / 100 === valor
  );
}

export function enviarValidacio(
  reply: FastifyReply,
  missatge: string,
  detalls?: { camp: string; missatge: string }[],
): void {
  reply.code(400).send(cosError('VALIDACIO', missatge, detalls));
}

export function enviarNoTrobat(reply: FastifyReply, missatge = 'No trobat'): void {
  reply.code(404).send(cosError('NO_TROBAT', missatge));
}

export function enviarConflicte(reply: FastifyReply, missatge: string): void {
  reply.code(409).send(cosError('CONFLICTE', missatge));
}

export function enviarSensePermis(reply: FastifyReply, missatge: string): void {
  reply.code(403).send(cosError('SENSE_PERMIS', missatge));
}

/**
 * Els 5 mòduls "operatius" — les 4 pantalles de panell més "comandes" — que
 * ja depenen avui, confirmat de debò contra el codi real de cada pantalla
 * (no suposat), de dades d'altres endpoints com a simple referència/consulta
 * (transportistes, tarifes, productes, clients): `office`/`packaging`
 * (transportistes+tarifes+clients), `workshop`/`production` (productes),
 * `orders` (clients+tarifes). Qualsevol rol amb AL MENYS UN d'aquests 5
 * mòduls pot LLEGIR (mai escriure) aquests recursos de referència — sense
 * això, per exemple Obrador (només `panell-obrador`) no podria carregar el
 * desplegable de productes de la seva pròpia pantalla.
 *
 * Marge conegut, verificat i no bloquejant amb els rols reals d'avui: dues
 * pantalles que NO tenen cap d'aquests 5 mòduls igualment depenen d'algun
 * d'aquests endpoints de referència (`pig-yields`, mòdul `rendiments-porcs`,
 * crida GET /categories; `client-tariffs`, mòdul `tarifes-clients`, crida
 * GET /tarifes/matriu) — als 6 rols reals d'avui això mai falla perquè cap
 * dels dos mòduls apareix mai TOT SOL sense algun dels 5 operatius. Si algun
 * dia es crea un rol nou amb NOMÉS `rendiments-porcs` o NOMÉS
 * `tarifes-clients` (la reconfiguració en viu ho permetria), aquesta
 * pantalla perdria la lectura de referència — documentat a propòsit, no és
 * un cas cobert avui.
 */
export const MODULS_OPERATIUS_APOYO = [
  'comandes',
  'panell-oficina',
  'panell-obrador',
  'panell-empaquetat',
  'panell-produccio',
] as const;

/**
 * Primer endpoint que restringió por módulo (`POST /usuaris`) — hasta ahora
 * ningún endpoint de negocio lo hacía (ADR-021: el cliente pidió que nadie
 * quedara bloqueado por rol; superado ahora por el hallazgo de seguridad de
 * autorización real por módulo, aplicado a los 37 endpoints que faltaban).
 * `req.usuariResolt` ya está seteado acá porque `crearMiddlewareResoldreUsuari()`
 * corre antes en el mismo scope de plugin (ver servidor.ts) — se usa como
 * `preHandler` de ruta (tercer argumento de `fastify.post/get/...`), no como
 * hook global, para que sólo bloquee los endpoints que explícitamente lo pidan.
 *
 * Acepta un módulo único (caso normal: escritura restringida al módulo
 * dueño) o una lista (caso "endpoint de apoyo": basta con tener AL MENOS UNO
 * de los módulos listados, nunca todos — ver MODULS_OPERATIUS_APOYO arriba).
 *
 * Callback-style explícito (tercer parámetro `done`), no async/Promise:
 * Fastify siempre invoca un preHandler como `fn(req, reply, done)` — si el
 * hook no es `async` ni devuelve una Promise, TIENE que llamar a `done()`
 * él mismo, o Fastify se queda esperando esa señal para siempre (nunca
 * avanza al handler, sin error ni timeout). En el rechazo, `reply.send()`
 * ya deja `reply.sent = true` — NO llamar a `done()` también ahí (sería un
 * doble envío de respuesta).
 */
export function crearGuardaModul(moduls: string | readonly string[]) {
  // `typeof` en vez de `Array.isArray` a propósito: la firma de lib.es5.d.ts
  // para `Array.isArray` es `(arg: any) => arg is any[]` — como type guard
  // narrowea a `any[]`, perdiendo el tipo `readonly string[]` y filtrando
  // `any` al resto de la función (detectado por el lint real, no una
  // preferencia de estilo).
  const modulsRequerits: readonly string[] = typeof moduls === 'string' ? [moduls] : moduls;
  const missatge =
    modulsRequerits.length === 1
      ? `Calen permisos del mòdul "${modulsRequerits[0]}" per a aquesta acció`
      : `Calen permisos d'algun d'aquests mòduls per a aquesta acció: ${modulsRequerits.join(', ')}`;
  return function guardaModul(
    req: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    const usuari = req.usuariResolt;
    if (!usuari || !modulsRequerits.some((modul) => usuari.rol.modulsPermesos.includes(modul))) {
      enviarSensePermis(reply, missatge);
      return;
    }
    done();
  };
}

/**
 * `23505` = unique_violation. El único otro lugar del backend que traduce
 * este código (resolucio-client.ts/ADR-023) resuelve un caso de negocio
 * distinto — un conflicto de identidad de cliente durante el sync, no una
 * alta manual por HTTP. Pensado para códigos únicos definidos por el
 * usuario (transportista.codi, tarifa.codi...):
 * en vez de dejar caer un 500 genérico, el `catch` de la ruta usa esto
 * para decidir si el error es "ya existe" (409) o algo inesperado (se
 * relanza, tal como antes).
 */
export function esViolacioCodiUnic(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === '23505';
}

/**
 * `:id` de la URL siempre es el entero secuencial público (id_seq), nunca
 * el UUID interno — ver ADR-019. `null` si el parámetro ni siquiera es un
 * entero válido (evita una consulta a la base para algo que ya sabemos que
 * no puede existir).
 */
export function parsearIdPublic(valor: string): number | null {
  if (!/^\d+$/.test(valor)) return null;
  const id = Number(valor);
  return Number.isSafeInteger(id) ? id : null;
}

async function resolverUuid(pool: Pool, taula: string, idSeq: number): Promise<string | null> {
  // `taula` nunca viene de una petición: siempre es uno de los literales de
  // abajo, fijados en el código — interpolarlo acá no es una inyección SQL.
  const res = await pool.query<{ id: string }>(`SELECT id FROM ${taula} WHERE id_seq = $1`, [
    idSeq,
  ]);
  return res.rows[0]?.id ?? null;
}

export const resolverProducteUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'producte', idSeq);
export const resolverCategoriaUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'categoria_producte', idSeq);
export const resolverTarifaUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'tarifa', idSeq);
export const resolverClientUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'client', idSeq);
export const resolverTransportistaUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'transportista', idSeq);
export const resolverComandaUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'comanda', idSeq);
export const resolverRendimentPorcUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'rendiments_porcs', idSeq);
export const resolverRolUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'rol', idSeq);
export const resolverUsuariUuid = (pool: Pool, idSeq: number): Promise<string | null> =>
  resolverUuid(pool, 'usuari', idSeq);
