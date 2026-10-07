import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WooOrder } from '@dpages/shared';
import { Client, Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { migrarArriba } from '../db/migrate.js';
import { transformarComanda } from './comandes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function leerFixture<T>(nombre: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, '../__fixtures__', nombre), 'utf8')) as T;
}

const comandaSimple = leerFixture<WooOrder>('comanda-simple.json'); // 1 línea, SKU LLF01, cantidad 1
const comandaMultilinia = leerFixture<WooOrder>('comanda-multilinia.json'); // 3 líneas: LLF01 x2 (ca), LLF01 x1 (es), BOT01 x3 (variación)

describe('transformarComanda (Postgres real, esquema aislado)', () => {
  const esquema = `test_comandes_${randomUUID().replaceAll('-', '_')}`;
  let poolTest: Pool;
  let producteLlomId: string;

  beforeAll(async () => {
    const setup = new Client({ connectionString: env.DATABASE_URL });
    await setup.connect();
    await setup.query(`CREATE SCHEMA "${esquema}"`);
    await setup.query(`SET search_path TO "${esquema}"`);
    await migrarArriba(setup);
    // Datos de arranque mínimos (ver seed-arranque.ts) que la migración no
    // siembra — desde la migración 0013, comanda.origen_id es NOT NULL y
    // crearComanda() resuelve contra la fila 'woocommerce'.
    await setup.query(
      `INSERT INTO origen_comanda (codi, nom) VALUES ('woocommerce', 'WooCommerce'), ('manual', 'Manual')`,
    );

    // Artículo con peso de ficha, y su alias — para que la línea LLF01 resuelva
    // con kgDemanats calculado (peso conocido, no "a medida").
    const producte = await setup.query<{ id: string }>(
      `INSERT INTO producte (codi, descripcio, pes_kg) VALUES ('LLF01', 'Llom', '1.250') RETURNING id`,
    );
    producteLlomId = producte.rows[0]!.id;
    await setup.query(
      `INSERT INTO alias_producte (producte_id, woo_product_id, woo_variation_id, idioma, codi)
       VALUES ($1, 6245, 0, 'ca', 'LLF01')`,
      [producteLlomId],
    );

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

  async function conClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await poolTest.connect();
    try {
      await client.query('BEGIN');
      const resultado = await fn(client);
      await client.query('COMMIT');
      return resultado;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  it('crea una comanda nueva con la cabecera y kgDemanats calculado con el peso de ficha', async () => {
    const resultado = await conClient((client) => transformarComanda(client, comandaSimple));

    expect(resultado.actualitzada).toBe(true);
    expect(resultado.liniesNoResoltes).toBe(0);

    const comanda = await poolTest.query(
      `SELECT estat, estat_web, poblacio_desti, total, data_produccio FROM comanda WHERE id = $1`,
      [resultado.comandaId],
    );
    // Tarea 38: las de WooCommerce nacen en esborrany.
    expect(comanda.rows[0]).toEqual({
      estat: 'esborrany',
      estat_web: comandaSimple.status,
      poblacio_desti: comandaSimple.shipping.city,
      total: comandaSimple.total,
      data_produccio: null, // Tarea 39: dimarts abans de les 16:00.
    });

    const linia = await poolTest.query(
      `SELECT producte_id, unitats_demanades, pes_fitxa_kg, pes_calculat_kg, pes_editable,
              data_produccio
       FROM comanda_linia WHERE comanda_id = $1`,
      [resultado.comandaId],
    );
    expect(linia.rows[0]).toEqual({
      producte_id: producteLlomId,
      unitats_demanades: '1.00', // NUMERIC(10,2), string
      pes_fitxa_kg: '1.250',
      pes_calculat_kg: '1.250',
      pes_editable: false,
      // Tarea 39: creada en dimarts 12/05 a les 10:15 (hora local) → sense data.
      data_produccio: null,
    });
  });

  it('línea sin artículo resuelto: se guarda con producte_id nulo y la comanda queda con incidencia', async () => {
    const resultado = await conClient((client) => transformarComanda(client, comandaMultilinia));

    // La 3ª línea (BOT01, variación 6415) no tiene ningún alias ni producte cargado.
    expect(resultado.liniesNoResoltes).toBe(1);

    const comanda = await poolTest.query<{ estat: string }>(
      `SELECT estat FROM comanda WHERE id = $1`,
      [resultado.comandaId],
    );
    // Tarea 38: la incidencia se registra, pero sigue en esborrany hasta
    // que oficina la revise.
    expect(comanda.rows[0]?.estat).toBe('esborrany');

    const incidencies = await poolTest.query<{ tipus: string }>(
      `SELECT tipus FROM incidencia_comanda WHERE comanda_id = $1`,
      [resultado.comandaId],
    );
    expect(incidencies.rows.map((r) => r.tipus)).toContain('article_no_resolt');

    // Tarea 39: creada en dimecres 03/06 → dilluns 08/06, en todas las líneas.
    const linies = await poolTest.query<{ data_produccio: Date | null }>(
      `SELECT data_produccio FROM comanda_linia WHERE comanda_id = $1`,
      [resultado.comandaId],
    );
    expect(linies.rows.map((l) => l.data_produccio?.toISOString())).toEqual(
      Array(linies.rows.length).fill('2026-06-08T00:00:00.000Z'),
    );
    const capcalera = await poolTest.query<{ data_produccio: Date | null }>(
      `SELECT data_produccio FROM comanda WHERE id = $1`,
      [resultado.comandaId],
    );
    expect(capcalera.rows[0]?.data_produccio?.toISOString()).toBe('2026-06-08T00:00:00.000Z');

    const liniaNoResolta = await poolTest.query(
      `SELECT producte_id, woo_sku, pes_calculat_kg, pes_editable FROM comanda_linia
       WHERE comanda_id = $1 AND woo_sku = 'BOT01'`,
      [resultado.comandaId],
    );
    expect(liniaNoResolta.rows[0]).toEqual({
      producte_id: null,
      woo_sku: 'BOT01',
      pes_calculat_kg: '0.000',
      pes_editable: true,
    });
  });

  it('guardián de versión: una versión no más nueva no toca nada', async () => {
    const primeraVez = await conClient((client) => transformarComanda(client, comandaSimple));

    const antes = await poolTest.query(`SELECT total FROM comanda WHERE id = $1`, [
      primeraVez.comandaId,
    ]);

    // Misma fecha (o más vieja): el guardián de versión descarta.
    const resultado = await conClient((client) => transformarComanda(client, comandaSimple));
    expect(resultado.actualitzada).toBe(false);
    expect(resultado.congelada).toBe(false);

    const despues = await poolTest.query(`SELECT total FROM comanda WHERE id = $1`, [
      primeraVez.comandaId,
    ]);
    expect(despues.rows[0]).toEqual(antes.rows[0]);
  });

  it('propiedad de columnas: los campos operativos sobreviven a una actualización del sync', async () => {
    // Comanda "desde cero", ya en producción, con datos operativos reales
    // cargados por oficina/obrador/empaquetado — nada de esto vino de Woo.
    const transportista = await poolTest.query<{ id: string }>(
      `INSERT INTO transportista (nom) VALUES ('DHL') RETURNING id`,
    );
    const comanda = await poolTest.query<{ id: string }>(
      `INSERT INTO comanda (
         woo_order_id, origen_id, estat, estat_web, poblacio_desti, total, data_modificacio_woo,
         data_comanda, data_produccio, data_expedicio, data_lliurament, transportista_id, obs_produccio
       ) VALUES (
         777001, (SELECT id FROM origen_comanda WHERE codi = 'woocommerce'), 'en_proces', 'processing',
         'Manresa', '10.00', '2026-01-01T00:00:00Z',
         '2026-01-01', '2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z', '2026-01-07T00:00:00Z', $1, 'Tallar més gruixut'
       ) RETURNING id`,
      [transportista.rows[0]?.id],
    );
    const comandaId = comanda.rows[0]!.id;

    const linia = await poolTest.query<{ id: string }>(
      `INSERT INTO comanda_linia (
         comanda_id, ordinal, woo_line_item_id, producte_id,
         unitats_demanades, preu_unitari, pes_calculat_kg,
         unitats_lliurades, kg_lliurats, confirmat_a, confirmat_per
       ) VALUES ($1, 0, 555001, $2, 1, '8.00', '1.250', 1, '1.250', '2026-01-08T09:00:00Z', 'firebase-uid-empaquetat')
       RETURNING id`,
      [comandaId, producteLlomId],
    );

    const wooOrderActualizado: WooOrder = {
      ...comandaSimple,
      id: 777001,
      status: 'completed', // esto SÍ debería actualizarse (estat_web es del sync)
      date_modified_gmt: '2026-08-15T10:00:00', // más nueva que 2026-01-01
      line_items: [{ ...comandaSimple.line_items[0]!, id: 555001 }],
    };

    const resultado = await conClient((client) => transformarComanda(client, wooOrderActualizado));
    expect(resultado.actualitzada).toBe(true);

    const comandaDespues = await poolTest.query<{
      estat_web: string | null;
      data_produccio: Date | null;
      data_expedicio: Date | null;
      data_lliurament: Date | null;
      transportista_id: string | null;
      obs_produccio: string | null;
    }>(
      `SELECT estat_web, data_produccio, data_expedicio, data_lliurament, transportista_id, obs_produccio
       FROM comanda WHERE id = $1`,
      [comandaId],
    );
    expect(comandaDespues.rows[0]?.estat_web).toBe('completed'); // sync-owned: sí cambió
    expect(comandaDespues.rows[0]?.data_produccio?.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(comandaDespues.rows[0]?.data_expedicio?.toISOString()).toBe('2026-01-06T00:00:00.000Z');
    expect(comandaDespues.rows[0]?.data_lliurament?.toISOString()).toBe('2026-01-07T00:00:00.000Z');
    expect(comandaDespues.rows[0]?.transportista_id).toBe(transportista.rows[0]?.id);
    expect(comandaDespues.rows[0]?.obs_produccio).toBe('Tallar més gruixut');

    const liniaDespues = await poolTest.query<{
      unitats_lliurades: string;
      kg_lliurats: string;
      confirmat_a: Date | null;
      confirmat_per: string | null;
      unitats_demanades: string;
    }>(
      `SELECT unitats_lliurades, kg_lliurats, confirmat_a, confirmat_per, unitats_demanades
       FROM comanda_linia WHERE id = $1`,
      [linia.rows[0]?.id],
    );
    // Propiedad del sistema: intactos.
    expect(liniaDespues.rows[0]?.unitats_lliurades).toBe('1.00'); // NUMERIC(10,2), string
    expect(liniaDespues.rows[0]?.kg_lliurats).toBe('1.250');
    expect(liniaDespues.rows[0]?.confirmat_a?.toISOString()).toBe('2026-01-08T09:00:00.000Z');
    expect(liniaDespues.rows[0]?.confirmat_per).toBe('firebase-uid-empaquetat');
    // Propiedad de WooCommerce: si hubiera cambiado, esto sí se actualiza (no cambió en este caso).
    expect(liniaDespues.rows[0]?.unitats_demanades).toBe('1.00');
  });

  it('regla de congelación: no toca cabecera ni líneas, registra incidencia', async () => {
    const primeraVez = await conClient((client) => transformarComanda(client, comandaSimple));
    // Una congelada ya salió de esborrany (oficina la revisó).
    await poolTest.query(`UPDATE comanda SET estat = 'oberta', congelat_a = now() WHERE id = $1`, [
      primeraVez.comandaId,
    ]);

    const antes = await poolTest.query<{ total: string; estat_web: string | null }>(
      `SELECT total, estat_web FROM comanda WHERE id = $1`,
      [primeraVez.comandaId],
    );

    const wooOrderActualizado: WooOrder = {
      ...comandaSimple,
      total: '999.99',
      status: 'cancelled',
      date_modified_gmt: '2026-09-01T00:00:00',
    };
    const resultado = await conClient((client) => transformarComanda(client, wooOrderActualizado));

    expect(resultado.congelada).toBe(true);

    const despues = await poolTest.query<{
      total: string;
      estat_web: string | null;
      estat: string;
    }>(`SELECT total, estat_web, estat FROM comanda WHERE id = $1`, [primeraVez.comandaId]);
    expect(despues.rows[0]?.total).toBe(antes.rows[0]?.total);
    expect(despues.rows[0]?.estat_web).toBe(antes.rows[0]?.estat_web);
    expect(despues.rows[0]?.estat).toBe('amb_incidencia');

    const incidencies = await poolTest.query<{ tipus: string }>(
      `SELECT tipus FROM incidencia_comanda WHERE comanda_id = $1`,
      [primeraVez.comandaId],
    );
    expect(incidencies.rows.map((r) => r.tipus)).toContain('actualitzacio_sobre_congelada');
  });

  it('una comanda cancellada sigue cancellada: la incidencia se registra pero no la reabre', async () => {
    // Id propio: no comparte fila con los demás tests que usan comandaSimple.
    const wooOrder: WooOrder = { ...comandaSimple, id: comandaSimple.id + 900000 };
    const primeraVez = await conClient((client) => transformarComanda(client, wooOrder));
    await poolTest.query(
      `UPDATE comanda SET estat = 'cancellada', congelat_a = now() WHERE id = $1`,
      [primeraVez.comandaId],
    );

    await conClient((client) =>
      transformarComanda(client, { ...wooOrder, date_modified_gmt: '2026-09-01T00:00:00' }),
    );

    const despues = await poolTest.query<{ estat: string }>(
      `SELECT estat FROM comanda WHERE id = $1`,
      [primeraVez.comandaId],
    );
    expect(despues.rows[0]?.estat).toBe('cancellada');
    const incidencies = await poolTest.query<{ tipus: string }>(
      `SELECT tipus FROM incidencia_comanda WHERE comanda_id = $1`,
      [primeraVez.comandaId],
    );
    expect(incidencies.rows.map((r) => r.tipus)).toContain('actualitzacio_sobre_congelada');
  });

  it('emparejamiento por (producte, ordinal) cuando woo_line_item_id cambió, y esborrat para las que ya no vienen', async () => {
    const wooOrderId = 777002;
    const v1: WooOrder = {
      ...comandaSimple,
      id: wooOrderId,
      date_modified_gmt: '2026-02-01T00:00:00',
      line_items: [
        { ...comandaSimple.line_items[0]!, id: 111, quantity: 2 },
        { ...comandaSimple.line_items[0]!, id: 112, quantity: 5 },
      ],
    };
    const primeraVez = await conClient((client) => transformarComanda(client, v1));

    const liniasV1 = await poolTest.query<{
      id: string;
      ordinal: number;
      woo_line_item_id: number;
    }>(
      `SELECT id, ordinal, woo_line_item_id FROM comanda_linia WHERE comanda_id = $1 ORDER BY ordinal`,
      [primeraVez.comandaId],
    );
    const idLineaOrdinal0 = liniasV1.rows[0]!.id;

    // WooCommerce "editó" el pedido: recreó los line_item_id (admin), pero el
    // primer artículo/ordinal sigue siendo el mismo — y se borró la segunda línea.
    const v2: WooOrder = {
      ...comandaSimple,
      id: wooOrderId,
      date_modified_gmt: '2026-02-02T00:00:00',
      line_items: [{ ...comandaSimple.line_items[0]!, id: 999, quantity: 2 }],
    };
    await conClient((client) => transformarComanda(client, v2));

    // woo_line_item_id es BIGINT: pg lo devuelve como string, no como number.
    const liniasV2 = await poolTest.query<{
      id: string;
      woo_line_item_id: string;
      esborrat: boolean;
    }>(
      `SELECT id, woo_line_item_id, esborrat FROM comanda_linia WHERE comanda_id = $1 ORDER BY ordinal`,
      [primeraVez.comandaId],
    );

    // Se actualizó la MISMA fila (mismo id), no se creó una nueva.
    expect(liniasV2.rows[0]?.id).toBe(idLineaOrdinal0);
    expect(liniasV2.rows[0]?.woo_line_item_id).toBe('999');
    expect(liniasV2.rows[0]?.esborrat).toBe(false);

    // La segunda línea (ordinal 1) ya no vino: esborrat, no eliminada.
    expect(liniasV2.rows).toHaveLength(2);
    expect(liniasV2.rows[1]?.esborrat).toBe(true);
  });

  it('crea el cliente y vincula comanda.client_id (ADR-020)', async () => {
    const resultado = await conClient((client) => transformarComanda(client, comandaSimple));

    const comanda = await poolTest.query<{ client_id: string | null }>(
      `SELECT client_id FROM comanda WHERE id = $1`,
      [resultado.comandaId],
    );
    expect(comanda.rows[0]?.client_id).not.toBeNull();

    const clients = await poolTest.query<{ nif: string | null }>(
      `SELECT nif FROM client WHERE id = $1`,
      [comanda.rows[0]!.client_id],
    );
    expect(clients.rows[0]?.nif).toBe('[redactat]');

    const total = await poolTest.query<{ count: string }>(
      `SELECT count(*) FROM client WHERE nif = '[redactat]'`,
    );
    expect(total.rows[0]?.count).toBe('1'); // exactamente un registro nuevo con ese NIF
  });

  it('sin NIF ni email resoluble: client_id queda null y se registra incidencia "sense_dades_client" (ADR-020) — no se duplica al reprocesar', async () => {
    const wooOrderId = 777003;
    const sinDatosCliente: WooOrder = {
      ...comandaSimple,
      id: wooOrderId,
      meta_data: [],
      billing: { ...comandaSimple.billing, email: '' },
    };

    const primeraVez = await conClient((client) => transformarComanda(client, sinDatosCliente));

    const comanda = await poolTest.query<{ client_id: string | null; estat: string }>(
      `SELECT client_id, estat FROM comanda WHERE id = $1`,
      [primeraVez.comandaId],
    );
    expect(comanda.rows[0]?.client_id).toBeNull();
    expect(comanda.rows[0]?.estat).toBe('esborrany'); // Tarea 38: sigue en esborrany, con la incidencia registrada.

    const incidencies = await poolTest.query<{ tipus: string }>(
      `SELECT tipus FROM incidencia_comanda WHERE comanda_id = $1 AND tipus = 'sense_dades_client'`,
      [primeraVez.comandaId],
    );
    expect(incidencies.rows).toHaveLength(1);

    // Reprocesar el mismo pedido sin cambios (guardián de versión lo
    // descarta, pero la resolución de cliente igual se reintenta) no debe
    // acumular una segunda incidencia.
    await conClient((client) => transformarComanda(client, sinDatosCliente));

    const incidenciesDespues = await poolTest.query<{ count: string }>(
      `SELECT count(*) FROM incidencia_comanda WHERE comanda_id = $1 AND tipus = 'sense_dades_client'`,
      [primeraVez.comandaId],
    );
    expect(incidenciesDespues.rows[0]?.count).toBe('1');
  });

  describe('conflicto de identidad de cliente en el camino EN VIVO (ADR-023, no el script de batch)', () => {
    it('un conflicto de email y uno de woo_customer_id: AMBOS pedidos quedan como comanda con incidencia, ninguno se pierde', async () => {
      // Cliente base, creado por un pedido normal: nif=NIF-BASE,
      // email=base@example.com, customer_id=555555.
      const pedidoBase: WooOrder = {
        ...comandaSimple,
        id: 777201,
        customer_id: 555555,
        meta_data: [{ id: 1, key: 'nif', value: 'NIF-BASE' }],
        billing: { ...comandaSimple.billing, email: 'base@example.com' },
      };
      await conClient((client) => transformarComanda(client, pedidoBase));

      // Pedido con conflicto de EMAIL: NIF nuevo (nunca visto) y
      // customer_id propio (no choca ahí), pero el email ya es del cliente
      // base — resolverOCrearClient declara ON CONFLICT (nif), así que el
      // choque real es en idx_client_email.
      const pedidoConflictoEmail: WooOrder = {
        ...comandaSimple,
        id: 777202,
        customer_id: 666666,
        meta_data: [{ id: 2, key: 'nif', value: 'NIF-CONFLICTO-EMAIL' }],
        billing: { ...comandaSimple.billing, email: 'base@example.com' },
      };

      // Pedido con conflicto de WOO_CUSTOMER_ID: NIF y email nuevos (nunca
      // vistos), pero el mismo customer_id que el cliente base — la misma
      // cuenta logueada trae un NIF distinto en este pedido.
      const pedidoConflictoWooCustomerId: WooOrder = {
        ...comandaSimple,
        id: 777203,
        customer_id: 555555,
        meta_data: [{ id: 3, key: 'nif', value: 'NIF-CONFLICTO-WOO' }],
        billing: { ...comandaSimple.billing, email: 'conflicto.woo@example.com' },
      };

      // Tal como corre en producción: cada pedido en su propia transacción
      // (BEGIN/COMMIT), no una compartida — mismo patrón que
      // transformarComandes() en el loop real, no el script de batch de ayer.
      const resultadoEmail = await conClient((client) =>
        transformarComanda(client, pedidoConflictoEmail),
      );
      const resultadoWoo = await conClient((client) =>
        transformarComanda(client, pedidoConflictoWooCustomerId),
      );

      // Ninguno de los dos se perdió: ambos existen como comanda.
      const comandas = await poolTest.query<{
        woo_order_id: string;
        client_id: string | null;
        estat: string;
      }>(
        `SELECT woo_order_id, client_id, estat FROM comanda WHERE woo_order_id IN (777202, 777203)`,
      );
      expect(comandas.rows).toHaveLength(2);
      for (const fila of comandas.rows) {
        expect(fila.client_id).toBeNull();
        expect(fila.estat).toBe('esborrany'); // Tarea 38.
      }

      const incidenciaEmail = await poolTest.query<{ tipus: string; detall: string }>(
        `SELECT tipus, detall FROM incidencia_comanda WHERE comanda_id = $1`,
        [resultadoEmail.comandaId],
      );
      expect(incidenciaEmail.rows).toHaveLength(1);
      expect(incidenciaEmail.rows[0]?.tipus).toBe('conflicte_identitat_client');
      expect(incidenciaEmail.rows[0]?.detall).toContain('email');

      const incidenciaWoo = await poolTest.query<{ tipus: string; detall: string }>(
        `SELECT tipus, detall FROM incidencia_comanda WHERE comanda_id = $1`,
        [resultadoWoo.comandaId],
      );
      expect(incidenciaWoo.rows).toHaveLength(1);
      expect(incidenciaWoo.rows[0]?.tipus).toBe('conflicte_identitat_client');
      expect(incidenciaWoo.rows[0]?.detall).toContain('woo_customer_id');

      // No se creó ningún cliente nuevo con esos NIF — el conflicto los
      // descartó, exactamente como con sense_dades_client.
      const clientsConflicto = await poolTest.query<{ count: string }>(
        `SELECT count(*) FROM client WHERE nif IN ('NIF-CONFLICTO-EMAIL', 'NIF-CONFLICTO-WOO')`,
      );
      expect(clientsConflicto.rows[0]?.count).toBe('0');

      // Reprocesar el mismo pedido en conflicto (sin cambios) no acumula una
      // segunda incidencia — mismo criterio de idempotencia que sense_dades_client.
      await conClient((client) => transformarComanda(client, pedidoConflictoEmail));
      const incidenciaEmailDespues = await poolTest.query<{ count: string }>(
        `SELECT count(*) FROM incidencia_comanda WHERE comanda_id = $1 AND tipus = 'conflicte_identitat_client'`,
        [resultadoEmail.comandaId],
      );
      expect(incidenciaEmailDespues.rows[0]?.count).toBe('1');
    });
  });
});
