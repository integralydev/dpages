import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WooOrder, WooProduct } from '@dpages/shared';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env.js';
import { migrarArriba } from '../../db/migrate.js';
import type { construirServidor as construirServidorType } from '../servidor.js';
import { comprobarPisoActivacioOResponder } from './tasques.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function leerFixture<T>(nombre: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, '../../__fixtures__', nombre), 'utf8')) as T;
}

const producteCa = leerFixture<WooProduct>('producte-ca.json');
const comandaSimple = leerFixture<WooOrder>('comanda-simple.json');

function respuestaPagina(items: unknown[], totalPaginas = 1): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-wp-totalpages': String(totalPaginas) },
  });
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
 * Mismo patrón que webhook.test.ts: un solo esquema para todo el archivo,
 * porque las rutas usan el pool singleton de db/pool.ts y `PGOPTIONS` sólo
 * se lee al abrir una conexión física nueva — cambiarlo a mitad de archivo
 * arriesgaría reutilizar una conexión ya pegada al esquema anterior.
 */
const esquema = `test_tasques_${randomUUID().replaceAll('-', '_')}`;
let poolTest: Pool;
let construirServidor: typeof construirServidorType;

beforeAll(async () => {
  const setup = new Client({ connectionString: env.DATABASE_URL });
  await setup.connect();
  await setup.query(`CREATE SCHEMA "${esquema}"`);
  await setup.query(`SET search_path TO "${esquema}"`);
  await migrarArriba(setup);
  // Dato de arranque mínimo (ver seed-arranque.ts, no lo aplica la
  // migración): desde la migración 0013, comanda.origen_id es NOT NULL y
  // la sincronización real crea comanda vía crearComanda().
  await setup.query(
    `INSERT INTO origen_comanda (codi, nom) VALUES ('woocommerce', 'WooCommerce'), ('manual', 'Manual')`,
  );
  await setup.end();

  poolTest = new Pool({ connectionString: env.DATABASE_URL, options: `-c search_path=${esquema}` });

  process.env.PGOPTIONS = `-c search_path=${esquema}`;
  // AUTH_DISABLED=false para todo este archivo (ADR-021): las tareas usan su
  // propio mecanismo (secreto compartido/OIDC, ver autenticacio-tasques.ts),
  // nunca un token de Firebase. Si el hook de negocio se aplicara acá por
  // error, los tests de "secreto correcto" de más abajo pasarían a fallar
  // con 401, delatando la regresión.
  process.env.AUTH_DISABLED = 'false';
  ({ construirServidor } = await import('../servidor.js'));
});

afterAll(async () => {
  delete process.env.PGOPTIONS;
  delete process.env.AUTH_DISABLED;
  await poolTest.end();
  const cleanup = new Client({ connectionString: env.DATABASE_URL });
  await cleanup.connect();
  await cleanup.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`);
  await cleanup.end();
});

/**
 * Unitario, sin servidor ni base de datos — mismo criterio que
 * autenticarTasca (autenticacio-tasques.test.ts): parámetros inyectables en
 * vez de depender de env.NODE_ENV/env.INGESTA_COMANDES_DES_DE reales. La
 * prueba de integración completa (bloquea ANTES de llamar a la tienda, no
 * aterriza nada) vive en tasques-sin-piso-produccion.test.ts — necesita
 * NODE_ENV=production de verdad ahí, que ESTE archivo no puede dar sin
 * romper el camino de secreto compartido que usan el resto de sus tests.
 */
describe('comprobarPisoActivacioOResponder', () => {
  function fakeReply() {
    const code = vi.fn();
    const send = vi.fn();
    const reply = { code, send };
    code.mockReturnValue(reply);
    return {
      reply: reply as unknown as Parameters<typeof comprobarPisoActivacioOResponder>[0],
      code,
      send,
    };
  }

  it('producción sin piso: responde 500 ERROR_INTERN y devuelve false', () => {
    const { reply, code, send } = fakeReply();
    const ok = comprobarPisoActivacioOResponder(reply, 'production', undefined);

    expect(ok).toBe(false);
    expect(code).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledTimes(1);
    const cuerpo = send.mock.calls[0]?.[0] as { error: { codi: string; missatge: string } };
    expect(cuerpo.error.codi).toBe('ERROR_INTERN');
    expect(cuerpo.error.missatge).toContain('INGESTA_COMANDES_DES_DE no está configurada');
  });

  it('producción con piso configurado: no responde nada, devuelve true', () => {
    const { reply, code, send } = fakeReply();
    const ok = comprobarPisoActivacioOResponder(reply, 'production', '2026-10-08T00:00:00Z');

    expect(ok).toBe(true);
    expect(code).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('fuera de producción sin piso: no responde nada, devuelve true (comportamiento actual intacto)', () => {
    const { reply, code } = fakeReply();
    const ok = comprobarPisoActivacioOResponder(reply, 'development', undefined);

    expect(ok).toBe(true);
    expect(code).not.toHaveBeenCalled();
  });
});

/**
 * NODE_ENV es 'test' en vitest.config.ts, así que autenticarTasca toma
 * siempre el camino de secreto compartido acá, nunca el de OIDC — ver
 * autenticacio-tasques.ts.
 */
describe.each([['/tasques/sync-comandes'], ['/tasques/sync-cataleg'], ['/tasques/reconciliar']])(
  'POST %s — autenticación',
  (url) => {
    it('rechaza con 401 sin cabecera Authorization', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({ method: 'POST', url });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { codi: 'NO_AUTENTICAT', missatge: 'No autoritzat' } });
      await fastify.close();
    });

    it('rechaza con 401 con un secreto incorrecto', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer secreto-equivocado' },
      });

      expect(res.statusCode).toBe(401);
      await fastify.close();
    });
  },
);

describe('POST /tasques/sync-comandes', () => {
  it('con secreto correcto: ingiere y transforma, y reintentarlo no duplica nada', async () => {
    fetchMock.mockResolvedValueOnce(respuestaPagina([comandaSimple]));

    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tasques/sync-comandes',
      headers: { authorization: `Bearer ${env.TASQUES_SECRET}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ingesta: { itemsProcessats: 1 } });

    const comanda = await poolTest.query(`SELECT id FROM comanda WHERE woo_order_id = $1`, [
      comandaSimple.id,
    ]);
    expect(comanda.rowCount).toBe(1);

    // Reintento de Cloud Scheduler: mismo lote, sin fetch nuevo mockeado más
    // que este (idempotencia — ver ADR-009 y el guardián de versión).
    fetchMock.mockResolvedValueOnce(respuestaPagina([comandaSimple]));
    const res2 = await fastify.inject({
      method: 'POST',
      url: '/tasques/sync-comandes',
      headers: { authorization: `Bearer ${env.TASQUES_SECRET}` },
    });
    expect(res2.statusCode).toBe(200);

    const comandaDespues = await poolTest.query(`SELECT id FROM comanda WHERE woo_order_id = $1`, [
      comandaSimple.id,
    ]);
    expect(comandaDespues.rowCount).toBe(1);

    await fastify.close();
  });
});

describe('POST /tasques/sync-cataleg', () => {
  it('con secreto correcto: ingiere y transforma el catálogo', async () => {
    fetchMock.mockResolvedValueOnce(respuestaPagina([producteCa]));

    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tasques/sync-cataleg',
      headers: { authorization: `Bearer ${env.TASQUES_SECRET}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ingesta: { itemsProcessats: 1 } });

    const article = await poolTest.query(`SELECT id FROM producte WHERE codi = $1`, [
      producteCa.sku,
    ]);
    expect(article.rowCount).toBe(1);

    await fastify.close();
  });
});

describe('POST /tasques/reconciliar', () => {
  it('con secreto correcto: fuerza la ventana de 7 días en comandas y catálogo', async () => {
    fetchMock
      .mockResolvedValueOnce(respuestaPagina([comandaSimple]))
      .mockResolvedValueOnce(respuestaPagina([producteCa]));

    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tasques/reconciliar',
      headers: { authorization: `Bearer ${env.TASQUES_SECRET}` },
    });

    expect(res.statusCode).toBe(200);

    const urlComandes = fetchMock.mock.calls[0]?.[0] as URL;
    const urlCataleg = fetchMock.mock.calls[1]?.[0] as URL;
    expect(urlComandes.searchParams.has('modified_after')).toBe(true);
    expect(urlCataleg.searchParams.has('modified_after')).toBe(true);

    await fastify.close();
  });
});
