import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WooOrder } from '@dpages/shared';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env.js';
import { migrarArriba } from '../../db/migrate.js';
import { calcularFirmaWebhook } from '../hmac.js';
import type { construirServidor as construirServidorType } from '../servidor.js';
import type { procesarEventoWebhook as procesarEventoWebhookType } from './webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function leerFixture<T>(nombre: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, '../../__fixtures__', nombre), 'utf8')) as T;
}

const comandaSimple = leerFixture<WooOrder>('comanda-simple.json');

function respuestaJson(cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: 200,
    headers: { 'content-type': 'application/json' },
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
 * Un único esquema aislado para todo el archivo, no uno por describe: las
 * rutas (webhook.ts, servidor.ts) usan el pool singleton de db/pool.ts, que
 * se instancia una sola vez por proceso de test y abre conexiones de forma
 * perezosa. `PGOPTIONS` es lo único que le llega a esas conexiones nuevas
 * sin reinyectar el pool en cada ruta — pero sólo funciona si se fija ANTES
 * de la primera consulta real, y una vez que el pool abrió una conexión con
 * un search_path, esa conexión queda pegada a él mientras viva. Por eso acá
 * todo comparte un solo esquema: no hay forma de cambiarlo a mitad de
 * archivo sin arriesgar que se reutilice una conexión con el search_path
 * viejo.
 */
const esquema = `test_webhook_${randomUUID().replaceAll('-', '_')}`;
let poolTest: Pool;
let construirServidor: typeof construirServidorType;
let procesarEventoWebhook: typeof procesarEventoWebhookType;

beforeAll(async () => {
  const setup = new Client({ connectionString: env.DATABASE_URL });
  await setup.connect();
  await setup.query(`CREATE SCHEMA "${esquema}"`);
  await setup.query(`SET search_path TO "${esquema}"`);
  await migrarArriba(setup);
  // Dato de arranque mínimo (ver seed-arranque.ts, no lo aplica la
  // migración): desde la migración 0013, comanda.origen_id es NOT NULL y
  // el procesamiento del webhook crea comanda vía crearComanda().
  await setup.query(
    `INSERT INTO origen_comanda (codi, nom) VALUES ('woocommerce', 'WooCommerce'), ('manual', 'Manual')`,
  );
  await setup.end();

  poolTest = new Pool({ connectionString: env.DATABASE_URL, options: `-c search_path=${esquema}` });

  // AUTH_DISABLED=false para todo este archivo (ADR-021): si alguna vez el
  // hook de autenticación de negocio quedara mal registrado y terminara
  // aplicándose también acá, los tests de "firma válida" de más abajo — que
  // nunca mandan cabecera Authorization con un token de Firebase — pasarían
  // a fallar con 401 en vez de 200, delatando la regresión.
  process.env.AUTH_DISABLED = 'false';

  // El pool singleton de la app (db/pool.ts) todavía no abrió ninguna
  // conexión física en este proceso de test — recién lo hace en la primera
  // consulta real. `PGOPTIONS` es el mecanismo que usa `pg` como fallback
  // para el parámetro `options` de conexión cuando no viene explícito en la
  // connection string (ver ConnectionParameters en node-postgres), así que
  // fijarlo acá, antes de importar cualquier módulo que dispare una consulta,
  // alcanza para que esas conexiones nazcan con el mismo search_path que usa
  // `poolTest` para verificar — sin tocar código de producción sólo para
  // hacerlo testeable.
  process.env.PGOPTIONS = `-c search_path=${esquema}`;

  ({ construirServidor } = await import('../servidor.js'));
  ({ procesarEventoWebhook } = await import('./webhook.js'));
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
 * fastify.inject() no abre ningún puerto real — simula la petición completa
 * a través del pipeline de Fastify, content-type parser incluido.
 */
describe('POST /webhooks/woocommerce', () => {
  it('rechaza con 401 si falta la firma, sin explicar por qué', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/webhooks/woocommerce',
      payload: JSON.stringify({ id: 1 }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { codi: 'NO_AUTENTICAT', missatge: 'No autoritzat' } });
    await fastify.close();
  });

  it('rechaza con 401 si la firma no coincide (cuerpo alterado)', async () => {
    const fastify = construirServidor();
    const payload = JSON.stringify({ id: 1 });
    const firma = calcularFirmaWebhook(Buffer.from('otro-cuerpo'), env.WEBHOOK_SECRET);

    const res = await fastify.inject({
      method: 'POST',
      url: '/webhooks/woocommerce',
      payload,
      headers: { 'content-type': 'application/json', 'x-wc-webhook-signature': firma },
    });

    expect(res.statusCode).toBe(401);
    await fastify.close();
  });

  it('con firma válida: responde 200 rápido y registra el evento', async () => {
    const fastify = construirServidor();
    const payload = JSON.stringify({ id: 555001 });
    const firma = calcularFirmaWebhook(Buffer.from(payload, 'utf8'), env.WEBHOOK_SECRET);

    const antes = Date.now();
    const res = await fastify.inject({
      method: 'POST',
      url: '/webhooks/woocommerce',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-wc-webhook-signature': firma,
        'x-wc-webhook-topic': 'order.updated',
      },
    });
    const duracionMs = Date.now() - antes;

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // No es una prueba de reloj estricta, pero confirma que no esperó a
    // ningún trabajo de red: el mock de fetch ni siquiera está configurado
    // para responder acá, así que si esto esperara la parte pesada colgaría.
    expect(duracionMs).toBeLessThan(1000);

    const evento = await poolTest.query<{ woo_order_id: string; signatura_valida: boolean }>(
      `SELECT woo_order_id, signatura_valida FROM esdeveniment_webhook WHERE woo_order_id = 555001`,
    );
    expect(evento.rows[0]?.signatura_valida).toBe(true);

    await fastify.close();
  });
});

/**
 * El trabajo de fondo en sí (fetch mockeado, sin red real) — se testea como
 * unidad aparte para no depender de tiempos de espera en el test de la ruta.
 */
describe('procesarEventoWebhook (fetch interceptado)', () => {
  it('el webhook es una notificación: pide el estado canónico (GET /orders/{id}) y transforma', async () => {
    fetchMock.mockResolvedValueOnce(respuestaJson(comandaSimple));

    const evento = await poolTest.query<{ id: number }>(
      `INSERT INTO esdeveniment_webhook (woo_order_id, topic, signatura_valida) VALUES ($1, 'order.updated', true) RETURNING id`,
      [comandaSimple.id],
    );

    await procesarEventoWebhook(comandaSimple.id, evento.rows[0]!.id);

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toContain(`orders/${comandaSimple.id}`);

    const comanda = await poolTest.query(`SELECT id FROM comanda WHERE woo_order_id = $1`, [
      comandaSimple.id,
    ]);
    expect(comanda.rowCount).toBe(1);

    const procesado = await poolTest.query<{ processat: boolean; error: string | null }>(
      `SELECT processat, error FROM esdeveniment_webhook WHERE id = $1`,
      [evento.rows[0]!.id],
    );
    expect(procesado.rows[0]).toEqual({ processat: true, error: null });
  });

  it('si falla la obtención del pedido, marca el evento con el error (sin volcar datos personales)', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 500, headers: { 'retry-after': '0' } }),
    );

    const evento = await poolTest.query<{ id: number }>(
      `INSERT INTO esdeveniment_webhook (woo_order_id, topic, signatura_valida) VALUES (999999, 'order.updated', true) RETURNING id`,
    );

    await procesarEventoWebhook(999999, evento.rows[0]!.id);

    const procesado = await poolTest.query<{ processat: boolean; error: string | null }>(
      `SELECT processat, error FROM esdeveniment_webhook WHERE id = $1`,
      [evento.rows[0]!.id],
    );
    expect(procesado.rows[0]?.processat).toBe(true);
    expect(procesado.rows[0]?.error).toContain('500');
  });

  // Piso de activación (08/10/2026) — entornActivacio/pisoActivacioStr
  // inyectables, mismo criterio que autenticarTasca: no hace falta mutar
  // NODE_ENV/INGESTA_COMANDES_DES_DE del proceso para probar los dos caminos.
  it('pedido anterior al piso: no crea comanda, el evento queda processat sin error (no es un fallo)', async () => {
    const wooOrderId = 95101;
    fetchMock.mockResolvedValueOnce(
      respuestaJson({ ...comandaSimple, id: wooOrderId, date_created_gmt: '2026-10-07T23:59:59Z' }),
    );

    const evento = await poolTest.query<{ id: number }>(
      `INSERT INTO esdeveniment_webhook (woo_order_id, topic, signatura_valida) VALUES ($1, 'order.updated', true) RETURNING id`,
      [wooOrderId],
    );

    await procesarEventoWebhook(
      wooOrderId,
      evento.rows[0]!.id,
      'development',
      '2026-10-08T00:00:00Z',
    );

    const comanda = await poolTest.query(`SELECT 1 FROM comanda WHERE woo_order_id = $1`, [
      wooOrderId,
    ]);
    expect(comanda.rowCount).toBe(0);

    const procesado = await poolTest.query<{ processat: boolean; error: string | null }>(
      `SELECT processat, error FROM esdeveniment_webhook WHERE id = $1`,
      [evento.rows[0]!.id],
    );
    expect(procesado.rows[0]).toEqual({ processat: true, error: null });
  });

  it('INGESTA_COMANDES_DES_DE ausente en producción: el error queda visible en esdeveniment_webhook.error', async () => {
    const wooOrderId = 95102;
    fetchMock.mockResolvedValueOnce(respuestaJson({ ...comandaSimple, id: wooOrderId }));

    const evento = await poolTest.query<{ id: number }>(
      `INSERT INTO esdeveniment_webhook (woo_order_id, topic, signatura_valida) VALUES ($1, 'order.updated', true) RETURNING id`,
      [wooOrderId],
    );

    await procesarEventoWebhook(wooOrderId, evento.rows[0]!.id, 'production', undefined);

    const comanda = await poolTest.query(`SELECT 1 FROM comanda WHERE woo_order_id = $1`, [
      wooOrderId,
    ]);
    expect(comanda.rowCount).toBe(0);

    const procesado = await poolTest.query<{ processat: boolean; error: string | null }>(
      `SELECT processat, error FROM esdeveniment_webhook WHERE id = $1`,
      [evento.rows[0]!.id],
    );
    expect(procesado.rows[0]?.processat).toBe(true);
    expect(procesado.rows[0]?.error).toContain(
      'INGESTA_COMANDES_DES_DE no está configurada en producción',
    );
  });

  it('ADR-026: la protección de líneas aplica igual por webhook que por polling', async () => {
    const wooOrderId = 97101;
    fetchMock.mockResolvedValueOnce(respuestaJson({ ...comandaSimple, id: wooOrderId }));
    const evento1 = await poolTest.query<{ id: number }>(
      `INSERT INTO esdeveniment_webhook (woo_order_id, topic, signatura_valida) VALUES ($1, 'order.updated', true) RETURNING id`,
      [wooOrderId],
    );
    await procesarEventoWebhook(wooOrderId, evento1.rows[0]!.id);

    const comanda = await poolTest.query<{ id: string }>(
      `SELECT id FROM comanda WHERE woo_order_id = $1`,
      [wooOrderId],
    );
    const comandaId = comanda.rows[0]!.id;
    // Mismo estado que dejarían las rutas de Oficina: marca fijada + línea editada.
    await poolTest.query(`UPDATE comanda SET linies_editades_a = now() WHERE id = $1`, [comandaId]);
    const linia = await poolTest.query<{ id: string }>(
      `SELECT id FROM comanda_linia WHERE comanda_id = $1`,
      [comandaId],
    );
    await poolTest.query(`UPDATE comanda_linia SET unitats_demanades = 42 WHERE id = $1`, [
      linia.rows[0]!.id,
    ]);

    // Llega una NUEVA notificación del mismo pedido (versión más nueva).
    fetchMock.mockResolvedValueOnce(
      respuestaJson({ ...comandaSimple, id: wooOrderId, date_modified_gmt: '2026-08-20T10:00:00' }),
    );
    const evento2 = await poolTest.query<{ id: number }>(
      `INSERT INTO esdeveniment_webhook (woo_order_id, topic, signatura_valida) VALUES ($1, 'order.updated', true) RETURNING id`,
      [wooOrderId],
    );
    await procesarEventoWebhook(wooOrderId, evento2.rows[0]!.id);

    const liniaDespues = await poolTest.query<{ unitats_demanades: string }>(
      `SELECT unitats_demanades FROM comanda_linia WHERE id = $1`,
      [linia.rows[0]!.id],
    );
    expect(liniaDespues.rows[0]?.unitats_demanades).toBe('42.00');

    const procesado = await poolTest.query<{ processat: boolean; error: string | null }>(
      `SELECT processat, error FROM esdeveniment_webhook WHERE id = $1`,
      [evento2.rows[0]!.id],
    );
    expect(procesado.rows[0]).toEqual({ processat: true, error: null });
  });
});
