import type {
  ComandaDetallApi,
  ComandaDuplicadaApi,
  FilaPanellObradorApi,
  ProducteApi,
  ProveidorApi,
  RespostaPaginada,
} from '@dpages/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { construirServidor as construirServidorType } from '../../servidor.js';
import {
  cuerpoJson,
  type EntornTestApi,
  netejarEntornApi,
  prepararEntornApi,
} from './test-suport.js';

// Punt 55 (reformulat amb el client, 18/11/2026): proveïdors.
describe('API negoci — /proveidors i proveïdor de línia (Postgres real, esquema aislado)', () => {
  let entorn: EntornTestApi;
  let construirServidor: typeof construirServidorType;
  let fastify: ReturnType<typeof construirServidorType>;
  let producteId: number;
  let producteSensePreferitId: number;

  beforeAll(async () => {
    entorn = await prepararEntornApi('proveidors');
    construirServidor = entorn.construirServidor;
    fastify = construirServidor();
    const p1 = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO producte (codi, descripcio, pes_kg, preu_venda) VALUES ('POL01', 'Pollastre', '2.000', '5.00') RETURNING id_seq`,
    );
    producteId = Number(p1.rows[0]!.id_seq);
    const p2 = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO producte (codi, descripcio, pes_kg, preu_venda) VALUES ('LLO01', 'Llonganissa', '0.500', '3.00') RETURNING id_seq`,
    );
    producteSensePreferitId = Number(p2.rows[0]!.id_seq);
  });

  afterAll(async () => {
    await fastify.close();
    await netejarEntornApi(entorn);
  });

  async function crearProveidor(nom: string): Promise<ProveidorApi> {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/proveidors',
      payload: { nom },
    });
    expect(res.statusCode).toBe(201);
    return cuerpoJson<ProveidorApi>(res);
  }

  async function crearComanda(linies: Record<string, unknown>[]): Promise<ComandaDetallApi> {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/comandes',
      payload: {
        dataComanda: '2026-11-18',
        dataLliurament: '2026-11-30T00:00:00Z',
        origen: 'manual',
        linies,
      },
    });
    expect(res.statusCode).toBe(201);
    return cuerpoJson<ComandaDetallApi>(res);
  }

  it('alta, llistat per nom, canvi de nom i nom repetit', async () => {
    const granja = await crearProveidor('  Granja Nord  ');
    expect(granja.nom).toBe('Granja Nord');
    await crearProveidor('Avícola Sud');

    const llistat = cuerpoJson<RespostaPaginada<ProveidorApi>>(
      await fastify.inject({ method: 'GET', url: '/api/v1/proveidors' }),
    );
    expect(llistat.dades.map((p) => p.nom)).toEqual(['Avícola Sud', 'Granja Nord']);

    const repetit = await fastify.inject({
      method: 'POST',
      url: '/api/v1/proveidors',
      payload: { nom: 'granja nord' },
    });
    expect(repetit.statusCode).toBe(409);

    const buit = await fastify.inject({
      method: 'POST',
      url: '/api/v1/proveidors',
      payload: { nom: '   ' },
    });
    expect(buit.statusCode).toBe(400);

    const canviat = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/proveidors/${granja.id}`,
      payload: { nom: 'Granja del Nord' },
    });
    expect(cuerpoJson<ProveidorApi>(canviat).nom).toBe('Granja del Nord');
  });

  it("proveïdor preferit a l'article: es posa, es valida i es treu", async () => {
    const proveidor = await crearProveidor('Proveïdor Article');
    const posat = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/productes/${producteId}`,
      payload: { proveidorDefecteId: proveidor.id },
    });
    expect(cuerpoJson<ProducteApi>(posat).proveidorDefecte).toEqual({
      id: proveidor.id,
      nom: 'Proveïdor Article',
    });

    const inexistent = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/productes/${producteId}`,
      payload: { proveidorDefecteId: 999999 },
    });
    expect(inexistent.statusCode).toBe(400);

    const tret = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/productes/${producteSensePreferitId}`,
      payload: { proveidorDefecteId: null },
    });
    expect(cuerpoJson<ProducteApi>(tret).proveidorDefecte).toBeNull();
  });

  it('línies: preferit per defecte, un altre, cap; canvi, duplicat i filtre d’Obrador', async () => {
    const preferit = await crearProveidor('Preferit');
    const altre = await crearProveidor('Altre');
    await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/productes/${producteId}`,
      payload: { proveidorDefecteId: preferit.id },
    });

    const comanda = await crearComanda([
      { producteId, unitatsDemanades: 1 },
      { producteId, unitatsDemanades: 2, proveidorId: altre.id },
      { producteId, unitatsDemanades: 3, proveidorId: null },
      { producteId: producteSensePreferitId, unitatsDemanades: 4 },
    ]);
    expect(comanda.linies.map((l) => l.proveidor?.nom ?? null)).toEqual([
      'Preferit',
      'Altre',
      null,
      null,
    ]);

    // Afegir una línia: també agafa el preferit.
    const afegida = await fastify.inject({
      method: 'POST',
      url: `/api/v1/comandes/${comanda.id}/linies`,
      payload: { producteId, unitatsDemanades: 5 },
    });
    expect(afegida.statusCode).toBe(201);
    expect(cuerpoJson<ComandaDetallApi>(afegida).linies.at(-1)?.proveidor?.nom).toBe('Preferit');

    // Canviar i treure.
    const [primera, segona] = comanda.linies;
    const canvi = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/comandes/${comanda.id}/linies/${primera!.id}`,
      payload: { proveidorId: altre.id },
    });
    expect(canvi.statusCode).toBe(200);
    const tret = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/comandes/${comanda.id}/linies/${segona!.id}`,
      payload: { proveidorId: null },
    });
    expect(tret.statusCode).toBe(200);
    const inexistent = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/comandes/${comanda.id}/linies/${segona!.id}`,
      payload: { proveidorId: 999999 },
    });
    expect(inexistent.statusCode).toBe(400);

    const despres = cuerpoJson<ComandaDetallApi>(
      await fastify.inject({ method: 'GET', url: `/api/v1/comandes/${comanda.id}` }),
    );
    const perLinia = despres.linies.map((l) => l.proveidor?.nom ?? null);
    expect(perLinia).toEqual(['Altre', null, null, null, 'Preferit']);

    // Duplicar: la còpia manté el proveïdor de cada línia.
    const dup = await fastify.inject({
      method: 'POST',
      url: '/api/v1/comandes/duplicar',
      payload: { ids: [comanda.id] },
    });
    const { comandes } = cuerpoJson<{ comandes: ComandaDuplicadaApi[] }>(dup);
    const copia = cuerpoJson<ComandaDetallApi>(
      await fastify.inject({ method: 'GET', url: `/api/v1/comandes/${comandes[0]!.id}` }),
    );
    expect(copia.linies.map((l) => l.proveidor?.nom ?? null)).toEqual(perLinia);

    // Panell Obrador: per proveïdor i «sense».
    async function liniesObrador(filtre: string): Promise<number[]> {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/panells/obrador?mida=200&${filtre}`,
      });
      expect(res.statusCode).toBe(200);
      return cuerpoJson<RespostaPaginada<FilaPanellObradorApi>>(res)
        .dades.filter((fila) => fila.comandaId === comanda.id)
        .map((fila) => fila.liniaId)
        .sort((a, b) => a - b);
    }
    const ids = despres.linies.map((l) => l.id);
    expect(await liniesObrador(`proveidorId=${altre.id}`)).toEqual([ids[0]]);
    expect(await liniesObrador(`proveidorId=${preferit.id}`)).toEqual([ids[4]]);
    expect(await liniesObrador('proveidorId=sense')).toEqual([ids[1], ids[2], ids[3]].sort());
    const invalid = await fastify.inject({
      method: 'GET',
      url: '/api/v1/panells/obrador?proveidorId=abc',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("no es pot esborrar si algun article o línia el fa servir; si no, s'esborra", async () => {
    const usat = await crearProveidor('Usat');
    await crearComanda([
      { producteId: producteSensePreferitId, unitatsDemanades: 1, proveidorId: usat.id },
    ]);
    const bloquejat = await fastify.inject({
      method: 'DELETE',
      url: `/api/v1/proveidors/${usat.id}`,
    });
    expect(bloquejat.statusCode).toBe(409);

    const lliure = await crearProveidor('Sense ús');
    const esborrat = await fastify.inject({
      method: 'DELETE',
      url: `/api/v1/proveidors/${lliure.id}`,
    });
    expect(esborrat.statusCode).toBe(204);
    const noTrobat = await fastify.inject({
      method: 'DELETE',
      url: `/api/v1/proveidors/${lliure.id}`,
    });
    expect(noTrobat.statusCode).toBe(404);
  });

  it("canviar només el proveïdor d'una línia web no bloqueja el sync (ADR-026)", async () => {
    const proveidor = await crearProveidor('Proveïdor sync');
    const comanda = await entorn.poolTest.query<{ id: string; id_seq: string }>(
      `INSERT INTO comanda (woo_order_id, origen_id, estat, data_comanda)
       VALUES (777001, (SELECT id FROM origen_comanda WHERE codi = 'woocommerce'), 'oberta', '2026-11-18')
       RETURNING id, id_seq`,
    );
    const linia = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO comanda_linia (comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari, pes_calculat_kg)
       VALUES ($1, 0, (SELECT id FROM producte WHERE id_seq = $2), 1, '5.00', '2.000')
       RETURNING id_seq`,
      [comanda.rows[0]!.id, producteId],
    );
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/comandes/${comanda.rows[0]!.id_seq}/linies/${linia.rows[0]!.id_seq}`,
      payload: { proveidorId: proveidor.id },
    });
    expect(res.statusCode).toBe(200);
    const marca = await entorn.poolTest.query<{ linies_editades_a: Date | null }>(
      'SELECT linies_editades_a FROM comanda WHERE id = $1',
      [comanda.rows[0]!.id],
    );
    expect(marca.rows[0]?.linies_editades_a).toBeNull();
  });
});
