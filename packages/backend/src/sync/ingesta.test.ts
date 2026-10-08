import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WooOrder, WooProduct } from '@dpages/shared';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';
import { migrarArriba } from '../db/migrate.js';
import { finestraReconciliacio, ingerirCataleg, ingerirComandes } from './ingesta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function leerFixture<T>(nombre: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, '../__fixtures__', nombre), 'utf8')) as T;
}

const producteCa = leerFixture<WooProduct>('producte-ca.json');
const producteEs = leerFixture<WooProduct>('producte-es.json');
const comandaSimple = leerFixture<WooOrder>('comanda-simple.json');

function respuestaPagina(items: unknown[], totalPaginas: number): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-wp-totalpages': String(totalPaginas) },
  });
}

/** retry-after: '0' para que un 500 "persistente" agote reintentos rápido en el test. */
function respuestaError(status: number): Response {
  return new Response(null, { status, headers: { 'retry-after': '0' } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Postgres real (docker-compose, servicio "postgres-test"), en un esquema
 * propio y descartable con el esquema REAL aplicado vía el runner de
 * migraciones — no se hand-rolean CREATE TABLE acá, para probar contra lo
 * mismo que corre en desarrollo/producción.
 */
describe('servicio de ingesta (Postgres real, esquema aislado; fetch interceptado)', () => {
  const esquema = `test_ingesta_${randomUUID().replaceAll('-', '_')}`;
  let poolTest: Pool;

  beforeAll(async () => {
    const setup = new Client({ connectionString: env.DATABASE_URL });
    await setup.connect();
    await setup.query(`CREATE SCHEMA "${esquema}"`);
    await setup.query(`SET search_path TO "${esquema}"`);
    await migrarArriba(setup);
    await setup.end();

    poolTest = new Pool({
      connectionString: env.DATABASE_URL,
      options: `-c search_path=${esquema}`,
    });
  });

  afterAll(async () => {
    await poolTest.end();
    const cleanup = new Client({ connectionString: env.DATABASE_URL });
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`);
    await cleanup.end();
  });

  it('primera ejecución sin cursor previo: ACOTADA a los últimos 30 días por defecto, no el histórico (ADR-017)', async () => {
    fetchMock.mockResolvedValueOnce(respuestaPagina([producteCa], 1));

    const antes = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const resultado = await ingerirCataleg(poolTest);

    expect(resultado.esCarregaCompleta).toBe(false);
    expect(resultado.itemsProcessats).toBe(1);

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    const modifiedAfter = url.searchParams.get('modified_after');
    expect(modifiedAfter).not.toBeNull();
    expect(Math.abs(new Date(`${modifiedAfter}Z`).getTime() - antes)).toBeLessThan(5000);

    const cursor = await poolTest.query<{
      cursor_en: Date | null;
      intents_fallits_consecutius: number;
    }>(
      `SELECT cursor_en, intents_fallits_consecutius FROM cursor_sincronitzacio WHERE recurs = 'products'`,
    );
    expect(cursor.rows[0]?.cursor_en).not.toBeNull();
    expect(cursor.rows[0]?.intents_fallits_consecutius).toBe(0);
  });

  it('la segunda ejecución ya usa el cursor guardado, con el solapamiento de 5 minutos restado', async () => {
    fetchMock.mockResolvedValueOnce(respuestaPagina([producteCa], 1));

    await ingerirCataleg(poolTest);

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    const modifiedAfter = url.searchParams.get('modified_after');
    expect(modifiedAfter).not.toBeNull();

    // date_modified_gmt del fixture menos 5 minutos, comparado en UTC.
    const esperado = new Date(`${producteCa.date_modified_gmt}Z`).getTime() - 5 * 60 * 1000;
    expect(new Date(`${modifiedAfter}Z`).getTime()).toBe(esperado);
  });

  it('ingerir el mismo lote dos veces es idempotente: no duplica filas en aterratge_woocommerce', async () => {
    fetchMock
      .mockResolvedValueOnce(respuestaPagina([producteEs], 1))
      .mockResolvedValueOnce(respuestaPagina([producteEs], 1));

    await ingerirCataleg(poolTest);
    await ingerirCataleg(poolTest);

    const filas = await poolTest.query<{ payload: WooProduct }>(
      `SELECT payload FROM aterratge_woocommerce WHERE recurs = 'products' AND woo_id = $1`,
      [producteEs.id],
    );
    expect(filas.rowCount).toBe(1);
    expect(filas.rows[0]?.payload.name).toBe(producteEs.name);
  });

  it('ingerirComandes manda "after" (piso de activación) si se le pasa, nunca a ingerirCataleg', async () => {
    fetchMock.mockResolvedValueOnce(respuestaPagina([comandaSimple], 1));

    await ingerirComandes(poolTest, undefined, '2026-10-08T07:00:00Z');

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('after')).toBe('2026-10-08T07:00:00Z');
    // dates_are_gmt=true ya viaja SIEMPRE en toda petición (PARAMS_OBLIGATORIOS,
    // cliente.ts) — no es algo que haya que agregar para esto en particular.
    expect(url.searchParams.get('dates_are_gmt')).toBe('true');
  });

  it('sin piso (undefined), ingerirComandes no manda "after" — comportamiento actual intacto', async () => {
    fetchMock.mockResolvedValueOnce(respuestaPagina([comandaSimple], 1));

    await ingerirComandes(poolTest, undefined, undefined);

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.has('after')).toBe(false);
  });

  it('si falla el lote (reintentos agotados), el cursor NO avanza y queda el fallo registrado', async () => {
    // 1) Ingesta exitosa primero, para dejar establecido un cursor previo.
    fetchMock.mockResolvedValueOnce(respuestaPagina([comandaSimple], 1));
    await ingerirComandes(poolTest);

    const antes = await poolTest.query<{ cursor_en: Date | null }>(
      `SELECT cursor_en FROM cursor_sincronitzacio WHERE recurs = 'orders'`,
    );
    const cursorPrevio = antes.rows[0]?.cursor_en;
    expect(cursorPrevio).toBeTruthy();

    // 2) Ahora falla de verdad: 500 persistente agota los reintentos del cliente.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(respuestaError(500));

    await expect(ingerirComandes(poolTest)).rejects.toThrow();

    const despues = await poolTest.query<{
      cursor_en: Date | null;
      ultim_error: string | null;
      intents_fallits_consecutius: number;
    }>(
      `SELECT cursor_en, ultim_error, intents_fallits_consecutius FROM cursor_sincronitzacio WHERE recurs = 'orders'`,
    );
    expect(despues.rows[0]?.cursor_en?.getTime()).toBe(cursorPrevio?.getTime());
    expect(despues.rows[0]?.ultim_error).toBeTruthy();
    expect(despues.rows[0]?.intents_fallits_consecutius).toBe(1);
  });
});

describe('finestraReconciliacio', () => {
  it('devuelve una fecha ~7 días atrás por defecto, en formato WooCommerce', () => {
    const antes = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const resultado = finestraReconciliacio();
    const resultadoMs = new Date(`${resultado}Z`).getTime();

    expect(resultado).not.toMatch(/[Z]|\.\d{3}/); // sin "Z" ni milisegundos, igual que WooCommerce
    expect(Math.abs(resultadoMs - antes)).toBeLessThan(5000); // tolerancia por el tiempo que tarda el test
  });

  it('acepta una cantidad de días distinta', () => {
    const antes = Date.now() - 1 * 24 * 60 * 60 * 1000;
    const resultadoMs = new Date(`${finestraReconciliacio(1)}Z`).getTime();
    expect(Math.abs(resultadoMs - antes)).toBeLessThan(5000);
  });
});
