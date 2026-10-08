import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WooOrder } from '@dpages/shared';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import type { migrarArriba as migrarArribaType } from '../../db/migrate.js';
import type { construirServidor as construirServidorType } from '../servidor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function leerFixture<T>(nombre: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, '../../__fixtures__', nombre), 'utf8')) as T;
}

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
 * Archivo APARTE de tasques.test.ts, con su propio esquema (mismo motivo de
 * siempre — un solo esquema por archivo, ver el comentario extenso en
 * tasques.test.ts/webhook.test.ts) y su PROPIO INGESTA_COMANDES_DES_DE.
 *
 * `env` (config/env.ts) es un singleton que se resuelve UNA SOLA VEZ, en el
 * primer import del módulo — ni siquiera un `import` de SÓLO TIPOS escapa
 * de esto si en algún punto se importa el VALOR (confirmado con un intento
 * real: un `import { env }` estático arriba de este archivo evaluaba
 * config/env.js antes de que `beforeAll` llegara a fijar `process.env`, y
 * el piso quedaba sin efecto — por eso NINGÚN import de este archivo toca
 * el valor de `env`/`migrarArriba`/`construirServidor` de forma estática,
 * todos son `import type` + `await import(...)` dinámico DESPUÉS de fijar
 * `process.env.INGESTA_COMANDES_DES_DE`, en ese orden exacto.
 */
const esquema = `test_tasques_piso_${randomUUID().replaceAll('-', '_')}`;
const PISO = '2026-10-08T00:00:00Z';
let envReal: Env;
let poolTest: Pool;
let construirServidor: typeof construirServidorType;

beforeAll(async () => {
  process.env.INGESTA_COMANDES_DES_DE = PISO;
  process.env.AUTH_DISABLED = 'false';

  ({ env: envReal } = await import('../../config/env.js'));
  const { migrarArriba }: { migrarArriba: typeof migrarArribaType } =
    await import('../../db/migrate.js');

  const setup = new Client({ connectionString: envReal.DATABASE_URL });
  await setup.connect();
  await setup.query(`CREATE SCHEMA "${esquema}"`);
  await setup.query(`SET search_path TO "${esquema}"`);
  await migrarArriba(setup);
  await setup.query(
    `INSERT INTO origen_comanda (codi, nom) VALUES ('woocommerce', 'WooCommerce'), ('manual', 'Manual')`,
  );
  await setup.end();

  poolTest = new Pool({
    connectionString: envReal.DATABASE_URL,
    options: `-c search_path=${esquema}`,
  });

  process.env.PGOPTIONS = `-c search_path=${esquema}`;
  ({ construirServidor } = await import('../servidor.js'));
});

afterAll(async () => {
  delete process.env.PGOPTIONS;
  delete process.env.AUTH_DISABLED;
  delete process.env.INGESTA_COMANDES_DES_DE;
  await poolTest.end();
  const cleanup = new Client({ connectionString: envReal.DATABASE_URL });
  await cleanup.connect();
  await cleanup.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`);
  await cleanup.end();
});

describe('POST /tasques/sync-comandes — piso de activación (08/10/2026)', () => {
  it('comandesOmesesPerData sale en la respuesta de la tarea, y el pedido anterior al piso no crea nada', async () => {
    const pedidoAnterior: WooOrder = {
      ...comandaSimple,
      id: 95201,
      date_created_gmt: '2026-10-07T23:59:59Z',
      billing: { ...comandaSimple.billing, email: 'anterior-tasca@example.com' },
    };
    const pedidoPosterior: WooOrder = {
      ...comandaSimple,
      id: 95202,
      date_created_gmt: '2026-10-08T00:00:01Z',
      billing: { ...comandaSimple.billing, email: 'posterior-tasca@example.com' },
    };
    fetchMock.mockResolvedValueOnce(respuestaPagina([pedidoAnterior, pedidoPosterior]));

    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tasques/sync-comandes',
      headers: { authorization: `Bearer ${envReal.TASQUES_SECRET}` },
    });

    expect(res.statusCode).toBe(200);
    const cuerpo = res.json<{
      transformacio: { comandesOmesesPerData: number; comandesActualitzades: number };
    }>();
    expect(cuerpo.transformacio.comandesOmesesPerData).toBe(1);
    expect(cuerpo.transformacio.comandesActualitzades).toBe(1);

    const comandaAnterior = await poolTest.query(
      `SELECT 1 FROM comanda WHERE woo_order_id = 95201`,
    );
    expect(comandaAnterior.rowCount).toBe(0);
    const comandaPosterior = await poolTest.query(
      `SELECT 1 FROM comanda WHERE woo_order_id = 95202`,
    );
    expect(comandaPosterior.rowCount).toBe(1);

    await fastify.close();
  });
});
