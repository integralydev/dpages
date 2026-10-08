import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WooProduct } from '@dpages/shared';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import type { migrarArriba as migrarArribaType } from '../../db/migrate.js';
import type { construirServidor as construirServidorType } from '../servidor.js';

// Mismo patrón que autenticacio-tasques.test.ts: simula una verificación
// OIDC exitosa de Cloud Scheduler, sin red real — es la única forma de
// ejercer el camino de NODE_ENV=production (autenticarTasca exige un token
// OIDC real ahí, nunca el secreto compartido) sin depender de Google.
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn().mockResolvedValue({}),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function leerFixture<T>(nombre: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, '../../__fixtures__', nombre), 'utf8')) as T;
}

const producteCa = leerFixture<WooProduct>('producte-ca.json');

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
 * Archivo APARTE (mismo motivo de siempre — un esquema y una configuración
 * de entorno por archivo): necesita NODE_ENV=production real para que
 * `autenticarTasca` tome el camino OIDC (arriba) y para que
 * `comprobarPisoActivacioOResponder` (tasques.ts) tome el camino de "falla
 * cerrado" — sin tocar `INGESTA_COMANDES_DES_DE` para nada, queda ausente a
 * propósito. Ningún import estático de `env`/`migrarArriba`/`construirServidor`
 * (mismo problema de timing ya documentado en tasques-piso-activacio.test.ts):
 * todos diferidos a `await import(...)` dentro de `beforeAll`, después de
 * fijar `process.env`.
 */
const esquema = `test_tasques_sin_piso_${randomUUID().replaceAll('-', '_')}`;
let envReal: Env;
let poolTest: Pool;
let construirServidor: typeof construirServidorType;

beforeAll(async () => {
  process.env.NODE_ENV = 'production';
  process.env.AUTH_DISABLED = 'false';
  process.env.TASQUES_OIDC_AUDIENCE = 'https://backend-xyz.run.app/tasques';
  delete process.env.INGESTA_COMANDES_DES_DE;

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
  delete process.env.NODE_ENV;
  delete process.env.TASQUES_OIDC_AUDIENCE;
  await poolTest.end();
  const cleanup = new Client({ connectionString: envReal.DATABASE_URL });
  await cleanup.connect();
  await cleanup.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`);
  await cleanup.end();
});

const BEARER_OIDC = 'Bearer token-de-cloud-scheduler-simulado';

describe('producción, INGESTA_COMANDES_DES_DE ausente: falla cerrado ANTES de llamar a la tienda', () => {
  it('POST /tasques/sync-comandes: 500 ERROR_INTERN, nunca llama a fetch, no aterriza nada (aunque el lote hubiera traído filas)', async () => {
    // Ni siquiera se mockea una respuesta — si el código llegara a llamar a
    // fetch, fallaría con "no hay mock configurado", delatando la regresión
    // de forma todavía más explícita que un simple toHaveBeenCalledTimes(0).
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tasques/sync-comandes',
      headers: { authorization: BEARER_OIDC },
    });

    expect(res.statusCode).toBe(500);
    const cuerpo: { error: { codi: string; missatge: string } } = res.json();
    expect(cuerpo.error.codi).toBe('ERROR_INTERN');
    expect(cuerpo.error.missatge).toContain('INGESTA_COMANDES_DES_DE no está configurada');
    expect(fetchMock).not.toHaveBeenCalled();

    const filas = await poolTest.query<{ count: string }>(
      `SELECT count(*) FROM aterratge_woocommerce`,
    );
    expect(filas.rows[0]?.count).toBe('0');

    await fastify.close();
  });

  it('POST /tasques/reconciliar: mismo bloqueo — tampoco sincroniza el catálogo en esa corrida', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tasques/reconciliar',
      headers: { authorization: BEARER_OIDC },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { codi: 'ERROR_INTERN' } });
    expect(fetchMock).not.toHaveBeenCalled();

    const filas = await poolTest.query<{ count: string }>(
      `SELECT count(*) FROM aterratge_woocommerce`,
    );
    expect(filas.rows[0]?.count).toBe('0');

    await fastify.close();
  });

  it('POST /tasques/sync-cataleg: NO se ve afectado — el piso es sólo para pedidos', async () => {
    fetchMock.mockResolvedValueOnce(respuestaPagina([producteCa]));

    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tasques/sync-cataleg',
      headers: { authorization: BEARER_OIDC },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await fastify.close();
  });
});
