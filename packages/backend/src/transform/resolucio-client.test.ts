import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WooOrder } from '@dpages/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { migrarArriba } from '../db/migrate.js';
import { ConflicteIdentitatClient, resolverOCrearClient } from './resolucio-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function leerFixture<T>(nombre: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, '../__fixtures__', nombre), 'utf8')) as T;
}

const comandaSimple = leerFixture<WooOrder>('comanda-simple.json'); // NIF por meta_data 'nif', billing.email presente
const comandaMultilinia = leerFixture<WooOrder>('comanda-multilinia.json'); // NIF distinto por '_billing_myfield5', invitado

describe('resolverOCrearClient (Postgres real, esquema aislado)', () => {
  const esquema = `test_resolucio_client_${randomUUID().replaceAll('-', '_')}`;
  const client = new Client({ connectionString: env.DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${esquema}"`);
    await client.query(`SET search_path TO "${esquema}"`);
    await migrarArriba(client);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`);
    await client.end();
  });

  it('con NIF nuevo (meta_data "nif"): crea exactamente un cliente y devuelve su id', async () => {
    await client.query('BEGIN');
    const clientId = await resolverOCrearClient(client, comandaSimple);
    await client.query('COMMIT');

    expect(clientId).not.toBeNull();

    const fila = await client.query<{
      nif: string | null;
      email: string | null;
      nom: string | null;
      codi: string | null;
      id_seq: string;
    }>('SELECT nif, email, nom, codi, id_seq FROM client WHERE id = $1', [clientId]);
    expect(fila.rows[0]).toMatchObject({
      nif: '[redactat]',
      email: 'restaurant.example@example.com',
      nom: 'Restaurant Example',
    });
    // El sync asigna codi automáticamente — CLI + id_seq, SIN padding
    // fijo (un ancho fijo truncaba en vez de ensanchar con id_seq de 4+
    // cifras — bug real, ver el comentario en resolucio-client.ts).
    // Único camino de alta de client sin codi obligatorio.
    expect(fila.rows[0]?.codi).toBe(`CLI${fila.rows[0]!.id_seq}`);

    const total = await client.query<{ count: string }>('SELECT count(*) FROM client');
    expect(total.rows[0]?.count).toBe('1');
  });

  it('NIF por "_billing_myfield5" (segunda clave de meta_data): también resuelve, invitado', async () => {
    await client.query('BEGIN');
    const clientId = await resolverOCrearClient(client, comandaMultilinia);
    await client.query('COMMIT');

    expect(clientId).not.toBeNull();
    const fila = await client.query<{ nif: string | null; es_convidat: boolean }>(
      'SELECT nif, es_convidat FROM client WHERE id = $1',
      [clientId],
    );
    expect(fila.rows[0]?.nif).toBe('[redactat-convidat]');
    expect(fila.rows[0]?.es_convidat).toBe(true); // customer_id = 0
  });

  it('el mismo NIF en un segundo pedido reutiliza el cliente — no duplica, ni pisa el email ya guardado', async () => {
    const segundoPedido: WooOrder = {
      ...comandaSimple,
      id: comandaSimple.id + 1,
      billing: { ...comandaSimple.billing, email: 'otro.email@example.com' },
    };

    await client.query('BEGIN');
    const primeraVez = await resolverOCrearClient(client, comandaSimple);
    const segundaVez = await resolverOCrearClient(client, segundoPedido);
    await client.query('COMMIT');

    expect(segundaVez).toBe(primeraVez);

    // El criterio de prioridad (NIF gana) resuelve la ambigüedad de forma
    // consistente: mismo NIF -> mismo cliente, y el email del PRIMER
    // pedido que lo creó se conserva (COALESCE, no se pisa).
    const fila = await client.query<{ email: string; codi: string | null }>(
      'SELECT email, codi FROM client WHERE id = $1',
      [primeraVez],
    );
    expect(fila.rows[0]?.email).toBe('restaurant.example@example.com');
    // El re-uso vía ON CONFLICT no regenera ni toca el codi ya asignado.
    expect(fila.rows[0]?.codi).toBe('CLI1');

    // No sumó un cliente nuevo: reutilizó el de "con NIF nuevo" (quedan los
    // mismos 2 de antes de este test — ese y el del invitado de "_billing_myfield5").
    const total = await client.query<{ count: string }>('SELECT count(*) FROM client');
    expect(total.rows[0]?.count).toBe('2');
  });

  it('sin NIF (meta_data vacío), resuelve por email — crea un cliente invitado nuevo', async () => {
    const soloEmail: WooOrder = {
      ...comandaSimple,
      id: 888001,
      customer_id: 0,
      meta_data: [], // sin NIF a propósito, para aislar el camino "sólo email"
      billing: { ...comandaSimple.billing, email: 'invitado.solo.email@example.com' },
    };

    await client.query('BEGIN');
    const clientId = await resolverOCrearClient(client, soloEmail);
    await client.query('COMMIT');

    expect(clientId).not.toBeNull();
    const fila = await client.query<{ nif: string | null; email: string; es_convidat: boolean }>(
      'SELECT nif, email, es_convidat FROM client WHERE id = $1',
      [clientId],
    );
    expect(fila.rows[0]?.nif).toBeNull();
    expect(fila.rows[0]?.email).toBe('invitado.solo.email@example.com');
    expect(fila.rows[0]?.es_convidat).toBe(true); // customer_id = 0
  });

  it('sin NIF ni email, no crea nada y devuelve null', async () => {
    const sinDatos: WooOrder = {
      ...comandaSimple,
      id: 999999,
      meta_data: [],
      billing: { ...comandaSimple.billing, email: '' },
    };

    await client.query('BEGIN');
    const clientId = await resolverOCrearClient(client, sinDatos);
    await client.query('COMMIT');

    expect(clientId).toBeNull();
  });

  describe('falsos conflictos: el mismo cliente con el NIF escrito distinto o sin NIF (23/11/2026)', () => {
    it('cliente creado sin NIF; un pedido posterior con NIF y el mismo email lo reutiliza y le completa el NIF', async () => {
      const sinNif: WooOrder = {
        ...comandaSimple,
        id: 777301,
        customer_id: 0,
        meta_data: [],
        billing: { ...comandaSimple.billing, email: 'Primer.Sense.Nif@example.com' },
      };
      const ambNif: WooOrder = {
        ...sinNif,
        id: 777302,
        meta_data: [{ id: 1, key: 'nif', value: 'NIF-COMPLETAT' }],
      };

      await client.query('BEGIN');
      const primer = await resolverOCrearClient(client, sinNif);
      const segon = await resolverOCrearClient(client, ambNif);
      await client.query('COMMIT');

      expect(segon).toBe(primer);
      const fila = await client.query<{ nif: string | null; email: string }>(
        'SELECT nif, email FROM client WHERE id = $1',
        [primer],
      );
      expect(fila.rows[0]).toEqual({ nif: 'NIF-COMPLETAT', email: 'primer.sense.nif@example.com' });
    });

    it('cliente dado de alta a mano sin NIF y con el email en mayúsculas: también lo encuentra', async () => {
      const alta = await client.query<{ id: string }>(
        `INSERT INTO client (nom, email) VALUES ('Alta manual', 'Alta.Manual@Example.com') RETURNING id`,
      );
      const pedido: WooOrder = {
        ...comandaSimple,
        id: 777303,
        customer_id: 0,
        meta_data: [{ id: 1, key: 'nif', value: 'NIF-ALTA-MANUAL' }],
        billing: { ...comandaSimple.billing, email: 'alta.manual@example.com' },
      };

      await client.query('BEGIN');
      const clientId = await resolverOCrearClient(client, pedido);
      await client.query('COMMIT');

      expect(clientId).toBe(alta.rows[0]!.id);
      const fila = await client.query<{ nif: string | null; nom: string }>(
        'SELECT nif, nom FROM client WHERE id = $1',
        [clientId],
      );
      // Completa el hueco (nif) pero no pisa lo que cargó oficina (nom).
      expect(fila.rows[0]).toEqual({ nif: 'NIF-ALTA-MANUAL', nom: 'Alta manual' });
    });

    it('el mismo NIF escrito distinto (guiones, puntos, espacios, minúsculas) es el mismo cliente, y no se reescribe', async () => {
      const primer: WooOrder = {
        ...comandaSimple,
        id: 777304,
        customer_id: 0,
        meta_data: [{ id: 1, key: 'nif', value: 'NIF-TEST.000.001' }],
        billing: { ...comandaSimple.billing, email: 'format.nif.1@example.com' },
      };
      const segon: WooOrder = {
        ...primer,
        id: 777305,
        meta_data: [{ id: 2, key: 'nif', value: ' nif test 000001 ' }],
        billing: { ...comandaSimple.billing, email: 'format.nif.2@example.com' },
      };

      await client.query('BEGIN');
      const idPrimer = await resolverOCrearClient(client, primer);
      const idSegon = await resolverOCrearClient(client, segon);
      await client.query('COMMIT');

      expect(idSegon).toBe(idPrimer);
      const fila = await client.query<{ nif: string; email: string }>(
        'SELECT nif, email FROM client WHERE id = $1',
        [idPrimer],
      );
      expect(fila.rows[0]).toEqual({ nif: 'NIF-TEST.000.001', email: 'format.nif.1@example.com' });
    });

    it('un "NIF" sin letras ni cifras se ignora y resuelve por email', async () => {
      const pedido: WooOrder = {
        ...comandaSimple,
        id: 777306,
        customer_id: 0,
        meta_data: [{ id: 1, key: 'nif', value: '-' }],
        billing: { ...comandaSimple.billing, email: 'nif.guio@example.com' },
      };

      await client.query('BEGIN');
      const clientId = await resolverOCrearClient(client, pedido);
      await client.query('COMMIT');

      const fila = await client.query<{ nif: string | null }>(
        'SELECT nif FROM client WHERE id = $1',
        [clientId],
      );
      expect(fila.rows[0]?.nif).toBeNull();
    });
  });

  describe('conflictos reales de identidad (dos NIF/email/woo_customer_id que no coinciden entre sí) — ADR-023', () => {
    it('NIF nuevo cuyo email ya pertenece a OTRO cliente existente: lanza ConflicteIdentitatClient("email"), no duplica ni mezcla silenciosamente', async () => {
      // Cliente A: nif=NIF-A, email=compartido@example.com, customer_id propio
      // (distinto del de B) para aislar el conflicto en el email, no en woo_customer_id.
      const pedidoA: WooOrder = {
        ...comandaSimple,
        id: 777101,
        customer_id: 111111,
        meta_data: [{ id: 1, key: 'nif', value: 'NIF-A' }],
        billing: { ...comandaSimple.billing, email: 'compartido@example.com' },
      };
      await client.query('BEGIN');
      const clienteA = await resolverOCrearClient(client, pedidoA);
      await client.query('COMMIT');
      expect(clienteA).not.toBeNull();

      // Pedido B: NIF distinto (nunca visto) y customer_id distinto, pero el
      // MISMO email que A. El upsert declara ON CONFLICT (nif) — el
      // conflicto real ocurre en el índice único de email, que no es el
      // target declarado, así que Postgres lo rechaza con un error real,
      // que resolverOCrearClient traduce a ConflicteIdentitatClient.
      const pedidoB: WooOrder = {
        ...comandaSimple,
        id: 777102,
        customer_id: 222222,
        meta_data: [{ id: 2, key: 'nif', value: 'NIF-B' }],
        billing: { ...comandaSimple.billing, email: 'compartido@example.com' },
      };

      await client.query('BEGIN');
      const promesa = resolverOCrearClient(client, pedidoB);
      await expect(promesa).rejects.toBeInstanceOf(ConflicteIdentitatClient);
      await expect(promesa).rejects.toMatchObject({ index: 'email' });
      await client.query('ROLLBACK');

      // No quedó ningún cliente con nif='NIF-B': el intento se revirtió entero.
      const total = await client.query<{ count: string }>(
        `SELECT count(*) FROM client WHERE nif = 'NIF-B'`,
      );
      expect(total.rows[0]?.count).toBe('0');
    });

    it('woo_customer_id ya pertenece a otro cliente con NIF distinto: lanza ConflicteIdentitatClient("woo_customer_id")', async () => {
      // Cliente C: nif=NIF-C, customer_id=333333.
      const pedidoC: WooOrder = {
        ...comandaSimple,
        id: 777103,
        customer_id: 333333,
        meta_data: [{ id: 3, key: 'nif', value: 'NIF-C' }],
        billing: { ...comandaSimple.billing, email: 'cliente.c@example.com' },
      };
      await client.query('BEGIN');
      const clienteC = await resolverOCrearClient(client, pedidoC);
      await client.query('COMMIT');
      expect(clienteC).not.toBeNull();

      // Pedido D: NIF y email nunca vistos (nada que ver con C), pero el
      // MISMO customer_id — la misma cuenta logueada de WooCommerce trae un
      // NIF distinto en este pedido (hallazgo de ADR-020).
      const pedidoD: WooOrder = {
        ...comandaSimple,
        id: 777104,
        customer_id: 333333,
        meta_data: [{ id: 4, key: 'nif', value: 'NIF-D' }],
        billing: { ...comandaSimple.billing, email: 'cliente.d@example.com' },
      };

      await client.query('BEGIN');
      const promesa = resolverOCrearClient(client, pedidoD);
      await expect(promesa).rejects.toBeInstanceOf(ConflicteIdentitatClient);
      await expect(promesa).rejects.toMatchObject({ index: 'woo_customer_id' });
      await client.query('ROLLBACK');

      const total = await client.query<{ count: string }>(
        `SELECT count(*) FROM client WHERE nif = 'NIF-D'`,
      );
      expect(total.rows[0]?.count).toBe('0');
    });
  });

  it('regresión: id_seq de 4+ cifras no trunca el codi (bug real: 4916/4918 colisionaban en "CLI491" con padding fijo a 3 dígitos)', async () => {
    // Fuerza el próximo id_seq a 4916 sin insertar miles de filas —
    // reproduce EXACTO el escenario real que disparó el 23505 contra
    // idx_client_codi. Al final del describe a propósito, con NIF/customer_id
    // exclusivos de este test, para no interferir con los conteos
    // acumulados que asumen los tests anteriores.
    await client.query('ALTER TABLE client ALTER COLUMN id_seq RESTART WITH 4916');

    const pedidoE: WooOrder = {
      ...comandaSimple,
      id: 777105,
      customer_id: 491601,
      meta_data: [{ id: 5, key: 'nif', value: 'NIF-REGRESSIO-E' }],
      billing: { ...comandaSimple.billing, email: 'regressio.e@example.com' },
    };
    const pedidoF: WooOrder = {
      ...comandaSimple,
      id: 777106,
      customer_id: 491701,
      meta_data: [{ id: 6, key: 'nif', value: 'NIF-REGRESSIO-F' }],
      billing: { ...comandaSimple.billing, email: 'regressio.f@example.com' },
    };

    await client.query('BEGIN');
    const idE = await resolverOCrearClient(client, pedidoE);
    const idF = await resolverOCrearClient(client, pedidoF);
    await client.query('COMMIT');

    const files = await client.query<{ id_seq: string; codi: string | null }>(
      'SELECT id_seq, codi FROM client WHERE id IN ($1, $2) ORDER BY id_seq ASC',
      [idE, idF],
    );
    expect(files.rows[0]).toEqual({ id_seq: '4916', codi: 'CLI4916' });
    expect(files.rows[1]).toEqual({ id_seq: '4917', codi: 'CLI4917' });
  });
});
