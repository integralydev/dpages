import type {
  ComandaDetallApi,
  PanellEmpaquetatApi,
  PanellObradorApi,
  PanellOficinaApi,
} from '@dpages/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { construirServidor as construirServidorType } from '../../servidor.js';
import {
  cuerpoJson,
  type EntornTestApi,
  netejarEntornApi,
  prepararEntornApi,
} from './test-suport.js';

describe('API negoci — /panells (Postgres real, esquema aislado)', () => {
  let entorn: EntornTestApi;
  let construirServidor: typeof construirServidorType;
  let producteId: number;

  beforeAll(async () => {
    entorn = await prepararEntornApi('panells');
    construirServidor = entorn.construirServidor;

    const producte = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO producte (codi, descripcio, pes_kg, preu_venda, tipus)
       VALUES ('LLF01', 'Llom fresc de porc', '1.250', '9.86', 'simple') RETURNING id_seq`,
    );
    producteId = Number(producte.rows[0]!.id_seq);

    const fastify = construirServidor();
    // 3 pedidos con la misma línea — más que la página (mida=2) para
    // verificar que `totals` cubre TODO lo filtrado, no sólo la página.
    for (let i = 0; i < 3; i++) {
      await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 2 }],
        },
      });
    }
    await fastify.close();
  });

  afterAll(() => netejarEntornApi(entorn));

  it('GET /panells/oficina: totals cubre todo lo filtrado, no sólo la página visible', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina?mida=2' });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<PanellOficinaApi>(res);
    expect(cuerpo.dades).toHaveLength(2); // página de 2
    expect(cuerpo.totals.comandes).toBe(3); // total real, no la página
    expect(cuerpo.totals.linies).toBe(3);
    expect(cuerpo.paginacio).toEqual({ pagina: 1, mida: 2, total: 3, totalPagines: 2 });

    await fastify.close();
  });

  it('GET /panells/empaquetat: una fila por línea, con liniesPendents/Confirmades correctos', async () => {
    const fastify = construirServidor();
    const abans = cuerpoJson<PanellEmpaquetatApi>(
      await fastify.inject({ method: 'GET', url: '/api/v1/panells/empaquetat' }),
    );
    expect(abans.totals.linies).toBe(3);
    expect(abans.totals.liniesConfirmades).toBe(0);
    expect(abans.totals.liniesPendents).toBe(3);

    const primeraLinia = abans.dades[0]!;
    await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/comandes/${primeraLinia.comandaId}/linies/${primeraLinia.liniaId}/lliurament`,
      payload: { unitatsLliurades: 2, kgLliurats: '2.500' },
    });

    const despres = cuerpoJson<PanellEmpaquetatApi>(
      await fastify.inject({ method: 'GET', url: '/api/v1/panells/empaquetat' }),
    );
    expect(despres.totals.liniesConfirmades).toBe(1);
    expect(despres.totals.liniesPendents).toBe(2);

    await fastify.close();
  });

  it('GET /panells/oficina: resumen liviano de incidencies (capa 10), sin el detalle completo', async () => {
    const fastify = construirServidor();

    const creada = await fastify.inject({
      method: 'POST',
      url: '/api/v1/comandes',
      payload: {
        dataComanda: '2026-08-01',
        dataLliurament: '2026-08-30T00:00:00Z',
        origen: 'manual',
        linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
      },
    });
    const comandaId = cuerpoJson<{ id: number }>(creada).id;
    const comandaUuid = await entorn.poolTest.query<{ id: string }>(
      `SELECT id FROM comanda WHERE id_seq = $1`,
      [comandaId],
    );
    await entorn.poolTest.query(
      `INSERT INTO incidencia_comanda (comanda_id, tipus, detall) VALUES ($1, 'sense_dades_client', 'Sense NIF ni email')`,
      [comandaUuid.rows[0]!.id],
    );

    const cuerpo = cuerpoJson<PanellOficinaApi>(
      await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina' }),
    );
    const fila = cuerpo.dades.find((f) => f.comandaId === comandaId);
    expect(fila?.totalIncidencies).toBe(1);
    expect(fila?.tipusIncidencia).toBe('sense_dades_client');

    await fastify.close();
  });

  // Al final del describe a propósito: crea un pedido más, y los tests
  // anteriores (empaquetat, oficina) asumen totales exactos sobre los 3 del
  // beforeAll — de haber ido antes, los habría roto.
  it('GET /panells/obrador: líneas de pedido individuales (liniaId/comandaId/client reales, no agregado)', async () => {
    const fastify = construirServidor();

    // Cliente real — para verificar que "client" resuelve a un valor real y
    // no queda hardcodeado en null.
    const client = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO client (nom, poblacio) VALUES ('Restaurant Example', 'Manresa') RETURNING id_seq`,
    );
    const clientId = Number(client.rows[0]!.id_seq);
    const creada = await fastify.inject({
      method: 'POST',
      url: '/api/v1/comandes',
      payload: {
        dataComanda: '2026-08-01',
        dataLliurament: '2026-08-30T00:00:00Z',
        origen: 'manual',
        clientId,
        linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 3 }],
      },
    });
    const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);
    const liniaCreada = comandaCreada.linies[0]!;

    const res = await fastify.inject({ method: 'GET', url: '/api/v1/panells/obrador?mida=200' });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<PanellObradorApi>(res);

    const filaNova = cuerpo.dades.find((f) => f.comandaId === comandaCreada.id);
    expect(filaNova).toBeDefined();
    expect(filaNova?.liniaId).toBe(liniaCreada.id);
    expect(filaNova?.client).toBe('Restaurant Example');
    expect(filaNova?.unitats).toBe('3.00'); // NUMERIC(10,2), string
    expect(filaNova?.kg).toBe('3.750'); // 3 × 1.250

    // Las 3 líneas del beforeAll siguen ahí, sin agrupar y sin cliente —
    // antes de esta reescritura habrían colapsado en una sola fila sumada.
    const filesDelBeforeAll = cuerpo.dades.filter(
      (f) => f.comandaId !== comandaCreada.id && f.unitats === '2.00' && f.client === null,
    );
    expect(filesDelBeforeAll.length).toBeGreaterThanOrEqual(3);

    // Ninguna fila comparte liniaId con otra — son líneas reales, no un agregado.
    expect(new Set(cuerpo.dades.map((f) => f.liniaId)).size).toBe(cuerpo.dades.length);

    await fastify.close();
  });

  // Filtros de Obrador (producte/format/envasat), pedidos por el demo de
  // Lovable. Al final del describe por el mismo motivo que el test
  // anterior: no debe alterar los totales que asumen los tests de
  // oficina/empaquetat de más arriba.
  it('GET /panells/obrador: filtros producte/format/envasat (capa 20)', async () => {
    const fastify = construirServidor();

    const producteFiltrat = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO producte (codi, descripcio, pes_kg, preu_venda, tipus, format, envasat)
       VALUES ('BOT01', 'Botifarra crua', '0.500', '6.20', 'simple', 'TALLAT', 'ESPECIAL')
       RETURNING id_seq`,
    );
    const producteFiltratId = Number(producteFiltrat.rows[0]!.id_seq);
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/comandes',
      payload: {
        dataComanda: '2026-08-01',
        dataLliurament: '2026-08-30T00:00:00Z',
        origen: 'manual',
        linies: [
          {
            dataProduccio: '2026-08-01T00:00:00Z',
            producteId: producteFiltratId,
            unitatsDemanades: 1,
          },
        ],
      },
    });

    // producte: coincidencia EXACTA case-insensitive (regla 3.1 transversal,
    // mismo criterio que /panells/produccio) — no substring.
    const perProducteMayus = cuerpoJson<PanellObradorApi>(
      await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/obrador?producte=BOTIFARRA%20CRUA',
      }),
    );
    expect(perProducteMayus.dades).toHaveLength(1);
    expect(perProducteMayus.dades[0]?.producte.descripcio).toBe('Botifarra crua');

    const perProducteParcial = cuerpoJson<PanellObradorApi>(
      await fastify.inject({ method: 'GET', url: '/api/v1/panells/obrador?producte=Botifarra' }),
    );
    expect(perProducteParcial.dades).toHaveLength(0); // substring no matchea

    // producte repetible (petició del client, 29/09/2026): OR entre valors.
    const perLlom = cuerpoJson<PanellObradorApi>(
      await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/obrador?producte=Llom%20fresc%20de%20porc',
      }),
    );
    expect(perLlom.totals.linies).toBeGreaterThan(0);
    const perTots2 = cuerpoJson<PanellObradorApi>(
      await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/obrador?producte=Llom%20fresc%20de%20porc&producte=botifarra%20crua&mida=200',
      }),
    );
    expect(perTots2.totals.linies).toBe(perLlom.totals.linies + 1);
    expect(new Set(perTots2.dades.map((f) => f.producte.descripcio))).toEqual(
      new Set(['Llom fresc de porc', 'Botifarra crua']),
    );

    const perProducteSenseMatch = cuerpoJson<PanellObradorApi>(
      await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/obrador?producte=No%20Existeix',
      }),
    );
    expect(perProducteSenseMatch.dades).toEqual([]);
    expect(perProducteSenseMatch.totals.linies).toBe(0);

    // format/envasat: coincidencia exacta.
    const perFormat = cuerpoJson<PanellObradorApi>(
      await fastify.inject({ method: 'GET', url: '/api/v1/panells/obrador?format=TALLAT' }),
    );
    expect(perFormat.dades.map((f) => f.liniaId)).toContain(perProducteMayus.dades[0]?.liniaId);
    expect(perFormat.dades.every((f) => f.format === 'TALLAT')).toBe(true);

    const perEnvasat = cuerpoJson<PanellObradorApi>(
      await fastify.inject({ method: 'GET', url: '/api/v1/panells/obrador?envasat=ESPECIAL' }),
    );
    expect(perEnvasat.dades.map((f) => f.liniaId)).toContain(perProducteMayus.dades[0]?.liniaId);
    expect(perEnvasat.dades.every((f) => f.envasat === 'ESPECIAL')).toBe(true);

    const perFormatSenseMatch = cuerpoJson<PanellObradorApi>(
      await fastify.inject({ method: 'GET', url: '/api/v1/panells/obrador?format=LLESCAT' }),
    );
    expect(perFormatSenseMatch.dades).toEqual([]);

    await fastify.close();
  });

  // Al final del describe por el mismo motivo que los dos anteriores: crea
  // pedidos propios y no debe alterar los totales que asumen los tests de
  // oficina/empaquetat de más arriba.
  describe('capa 35 — obsProduccio (capçalera o línia), 4 filtres nous i bultos a GET /panells/oficina', () => {
    it('obsProduccio: true quan NOMÉS una línia (activa) té contingut, encara que la capçalera estigui buida', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);
      expect(comandaCreada.obsProduccio).toBeNull(); // capçalera buida

      await entorn.poolTest.query(
        `UPDATE comanda_linia SET obs_produccio = 'Tallar més fi' WHERE id_seq = $1`,
        [comandaCreada.linies[0]!.id],
      );

      const cuerpo = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina' }),
      );
      const fila = cuerpo.dades.find((f) => f.comandaId === comandaCreada.id);
      expect(fila?.obsProduccio).toBe(true);

      await fastify.close();
    });

    it('obsProduccio: false quan no hi ha cap observació ni a capçalera ni a cap línia activa', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      const cuerpo = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina' }),
      );
      const fila = cuerpo.dades.find((f) => f.comandaId === comandaCreada.id);
      expect(fila?.obsProduccio).toBe(false);

      await fastify.close();
    });

    it('obsLliurament NO cambia con esta capa: sigue siendo el texto de la cabecera, sin mirar líneas (comanda_linia no tiene esa columna)', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          obsLliurament: 'Entregar pels matins',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      const cuerpo = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina' }),
      );
      const fila = cuerpo.dades.find((f) => f.comandaId === comandaCreada.id);
      expect(fila?.obsLliurament).toBe('Entregar pels matins');

      await fastify.close();
    });

    it('filtre ?tarifaId=: coincidència exacta, sense match → dades: []', async () => {
      const fastify = construirServidor();
      const tarifa = await entorn.poolTest.query<{ id: string; id_seq: string }>(
        `INSERT INTO tarifa (codi, nom) VALUES ('CAP35-TAR', 'Tarifa capa 35') RETURNING id, id_seq`,
      );
      const tarifaIdPublic = Number(tarifa.rows[0]!.id_seq);
      const client = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO client (nom, poblacio, tarifa_id) VALUES ('Client capa 35', 'Vic', $1) RETURNING id_seq`,
        [tarifa.rows[0]!.id],
      );
      const clientIdPublic = Number(client.rows[0]!.id_seq);
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          clientId: clientIdPublic,
          tarifaId: tarifaIdPublic,
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      const perTarifa = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: `/api/v1/panells/oficina?tarifaId=${tarifaIdPublic}`,
        }),
      );
      expect(perTarifa.dades.map((f) => f.comandaId)).toContain(comandaCreada.id);
      expect(perTarifa.dades.every((f) => f.tarifa === 'Tarifa capa 35')).toBe(true);

      const senseMatch = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina?tarifaId=999999' }),
      );
      expect(senseMatch.dades).toEqual([]);

      await fastify.close();
    });

    it('filtre ?poblacioDesti=: coincidència exacta case-insensitive, sense match → dades: []', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);
      await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaCreada.id}`,
        payload: { poblacioDesti: 'Girona Capa 35' },
      });

      const perPoblacio = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?poblacioDesti=GIRONA%20CAPA%2035',
        }),
      );
      expect(perPoblacio.dades.map((f) => f.comandaId)).toContain(comandaCreada.id);

      const senseMatch = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?poblacioDesti=No%20Existeix',
        }),
      );
      expect(senseMatch.dades).toEqual([]);

      await fastify.close();
    });

    it('filtres ?dataComandaDes=/?dataComandaFins=: rang sobre dataComanda, fora de rang → dades: []', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      // Rang ampli que cobreix "ara" — ha de matchejar.
      const dinsDeRang = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?dataComandaDes=2020-01-01&dataComandaFins=2099-12-31',
        }),
      );
      expect(dinsDeRang.dades.map((f) => f.comandaId)).toContain(comandaCreada.id);

      // Rang al futur — cap comanda (ni aquesta ni cap de les del fixture) es
      // va crear amb dataComanda al futur.
      const foraDeRang = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?dataComandaDes=2099-01-01&dataComandaFins=2099-12-31',
        }),
      );
      expect(foraDeRang.dades).toEqual([]);

      await fastify.close();
    });

    it('filtres ?dataLliuramentDes=/?dataLliuramentFins=: rang sobre dataLliurament, fora de rang → dades: []', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          origen: 'manual',
          dataLliurament: '2026-08-20T00:00:00Z',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      const dinsDeRang = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?dataLliuramentDes=2026-08-19&dataLliuramentFins=2026-08-21',
        }),
      );
      expect(dinsDeRang.dades.map((f) => f.comandaId)).toContain(comandaCreada.id);

      const foraDeRang = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?dataLliuramentDes=2026-09-01&dataLliuramentFins=2026-09-30',
        }),
      );
      expect(foraDeRang.dades).toEqual([]);

      await fastify.close();
    });

    it('bultos surt a la resposta amb el valor correcte', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);
      expect(comandaCreada.bultos).toBeNull();

      await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaCreada.id}`,
        payload: { bultos: 5 },
      });

      const cuerpo = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina' }),
      );
      const fila = cuerpo.dades.find((f) => f.comandaId === comandaCreada.id);
      expect(fila?.bultos).toBe(5);

      await fastify.close();
    });
  });

  // Bug sistémico: "...Fins" se interpretaba como medianoche del día,
  // cortando afuera cualquier registro con hora real dentro de ese mismo
  // día. Al final del describe
  // por el mismo motivo que los bloques anteriores.
  describe('capa 36 — els filtres "...Fins" inclouen el dia complet', () => {
    it('GET /panells/oficina?dataExpedicioDes=&dataExpedicioFins= del MISMO día (con hora real) matchea', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);
      await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaCreada.id}`,
        payload: { dataExpedicio: '2026-08-28T14:14:00Z' },
      });

      const cuerpo = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?dataExpedicioDes=2026-08-28&dataExpedicioFins=2026-08-28',
        }),
      );
      expect(cuerpo.dades.some((f) => f.comandaId === comandaCreada.id)).toBe(true);

      await fastify.close();
    });

    it('GET /panells/oficina?dataComandaDes=avui&dataComandaFins=avui: un pedido con dataComanda=HOY matchea', async () => {
      // Issue #16 — dataComanda ya NO es comanda.creat_en: se fija explícito
      // con "avui" en el body, no se deriva del momento del INSERT.
      const avui = new Date().toISOString().slice(0, 10);
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: avui,
          // Issue #16 (segona ronda) — regla 7: dataComanda no pot ser
          // posterior a dataLliurament. No es pot fixar dataLliurament amb
          // una data fixa del passat (aquest test compara contra "avui", el
          // rellotge REAL del sistema, que avança), així que cal una data
          // sempre posterior a "avui" — es tria un any llunyà fora de
          // qualsevol rang que altres tests d'aquest fitxer facin servir
          // (tots amb dates fixes de 2026), per no fer-los matchear per
          // accident (els pedidos que crea cada test queden a la mateixa
          // base — no hi ha neteja entre tests d'aquest fitxer).
          dataLliurament: '2030-01-01T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      const cuerpo = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: `/api/v1/panells/oficina?dataComandaDes=${avui}&dataComandaFins=${avui}`,
        }),
      );
      expect(cuerpo.dades.some((f) => f.comandaId === comandaCreada.id)).toBe(true);

      await fastify.close();
    });

    it('GET /panells/oficina?dataLliuramentDes=&dataLliuramentFins= del MISMO día (con hora real) matchea', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          origen: 'manual',
          dataLliurament: '2026-08-28T14:14:00Z',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      const cuerpo = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?dataLliuramentDes=2026-08-28&dataLliuramentFins=2026-08-28',
        }),
      );
      expect(cuerpo.dades.some((f) => f.comandaId === comandaCreada.id)).toBe(true);

      await fastify.close();
    });

    it('GET /panells/obrador?dataProduccioDes=&dataProduccioFins= del MISMO día que la línea (con hora real) matchea', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);
      await entorn.poolTest.query(
        `UPDATE comanda_linia SET data_produccio = '2026-08-28T14:14:00Z' WHERE id_seq = $1`,
        [comandaCreada.linies[0]!.id],
      );

      const cuerpo = cuerpoJson<PanellObradorApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/obrador?dataProduccioDes=2026-08-28&dataProduccioFins=2026-08-28',
        }),
      );
      expect(cuerpo.dades.some((f) => f.comandaId === comandaCreada.id)).toBe(true);

      await fastify.close();
    });

    it('GET /panells/empaquetat?dataExpedicioDes=&dataExpedicioFins= del MISMO día (con hora real) matchea', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);
      await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaCreada.id}`,
        payload: { dataExpedicio: '2026-08-28T14:14:00Z' },
      });

      const cuerpo = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/empaquetat?dataExpedicioDes=2026-08-28&dataExpedicioFins=2026-08-28',
        }),
      );
      expect(cuerpo.dades.some((f) => f.comandaId === comandaCreada.id)).toBe(true);

      await fastify.close();
    });
  });

  // unitatsDemanades/unitatsLliurades pasaron de INTEGER a NUMERIC(10,2)
  // (migración 0016). Al final del describe por el mismo motivo que los
  // bloques anteriores.
  describe('capa 38 — unitatsDemanades/unitatsLliurades com a string (NUMERIC(10,2))', () => {
    it('GET /panells/obrador: el tipus de sortida d’unitats és string, amb decimals reals', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 2.5 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      const cuerpo = cuerpoJson<PanellObradorApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/obrador?mida=200' }),
      );
      const fila = cuerpo.dades.find((f) => f.comandaId === comandaCreada.id);
      expect(typeof fila?.unitats).toBe('string');
      expect(fila?.unitats).toBe('2.50');

      await fastify.close();
    });

    it('GET /panells/empaquetat: unitatsDemanades/unitatsLliurades (línia i totals) surten com a string', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 2.5 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);
      await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaCreada.id}/linies/${comandaCreada.linies[0]!.id}/lliurament`,
        payload: { unitatsLliurades: 2.5, kgLliurats: '3.125' },
      });

      const cuerpo = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/empaquetat' }),
      );
      const fila = cuerpo.dades.find((f) => f.comandaId === comandaCreada.id);
      expect(typeof fila?.unitatsDemanades).toBe('string');
      expect(typeof fila?.unitatsLliurades).toBe('string');
      expect(fila?.unitatsDemanades).toBe('2.50');
      expect(fila?.unitatsLliurades).toBe('2.50');
      expect(typeof cuerpo.totals.unitatsDemanades).toBe('string');
      expect(typeof cuerpo.totals.unitatsLliurades).toBe('string');

      await fastify.close();
    });
  });

  // 2 filtros que faltaban en GET /panells/empaquetat. Al final del
  // describe por el mismo motivo que los bloques anteriores: crea pedidos
  // propios y no debe alterar los totales que
  // asumen los tests de oficina/empaquetat de más arriba.
  describe('capa 37 — filtres dataLliuramentDes/Fins i producte a GET /panells/empaquetat', () => {
    it('filtres ?dataLliuramentDes=/?dataLliuramentFins=: rang complet del dia (capa 36), fora de rang → dades: []', async () => {
      const fastify = construirServidor();
      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          origen: 'manual',
          dataLliurament: '2026-08-28T14:14:00Z',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaCreada = cuerpoJson<ComandaDetallApi>(creada);

      const dinsDeRang = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/empaquetat?dataLliuramentDes=2026-08-28&dataLliuramentFins=2026-08-28',
        }),
      );
      expect(dinsDeRang.dades.some((f) => f.comandaId === comandaCreada.id)).toBe(true);

      const foraDeRang = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/empaquetat?dataLliuramentDes=2026-09-01&dataLliuramentFins=2026-09-30',
        }),
      );
      expect(foraDeRang.dades).toEqual([]);

      await fastify.close();
    });

    it('filtre ?producte=: coincidència exacta case-insensitive, sense match → dades: []', async () => {
      const fastify = construirServidor();
      const producteFiltrat = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO producte (codi, descripcio, pes_kg, preu_venda, tipus)
         VALUES ('CAP37-BOT', 'Botifarra de capa 37', '0.500', '6.20', 'simple')
         RETURNING id_seq`,
      );
      const producteFiltratId = Number(producteFiltrat.rows[0]!.id_seq);
      await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [
            {
              dataProduccio: '2026-08-01T00:00:00Z',
              producteId: producteFiltratId,
              unitatsDemanades: 1,
            },
          ],
        },
      });

      const perProducteMayus = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/empaquetat?producte=BOTIFARRA%20DE%20CAPA%2037',
        }),
      );
      expect(perProducteMayus.dades.length).toBeGreaterThanOrEqual(1);
      expect(perProducteMayus.dades.every((f) => f.producte === 'Botifarra de capa 37')).toBe(true);

      const perProducteParcial = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/empaquetat?producte=Botifarra',
        }),
      );
      expect(perProducteParcial.dades).toEqual([]); // substring no matchea

      const senseMatch = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/empaquetat?producte=No%20Existeix',
        }),
      );
      expect(senseMatch.dades).toEqual([]);

      await fastify.close();
    });
  });

  describe("peticions d'Ari — categoria i confirmacio a GET /panells/empaquetat", () => {
    it('categoria a cada fila, filtre categoriaId i filtre confirmacio (pendents/confirmades/totes)', async () => {
      const fastify = construirServidor();

      const categoria = await entorn.poolTest.query<{ id: string; id_seq: string }>(
        `INSERT INTO categoria_producte (nom) VALUES ('XAI') RETURNING id, id_seq`,
      );
      const categoriaId = Number(categoria.rows[0]!.id_seq);
      const producte = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO producte (codi, descripcio, pes_kg, preu_venda, tipus, categoria_id)
         VALUES ('XAI01', 'Xai en canal', '10.000', '12.00', 'simple', $1) RETURNING id_seq`,
        [categoria.rows[0]!.id],
      );
      const producteXaiId = Number(producte.rows[0]!.id_seq);
      await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [
            {
              dataProduccio: '2026-08-01T00:00:00Z',
              producteId: producteXaiId,
              unitatsDemanades: 1,
            },
            {
              dataProduccio: '2026-08-01T00:00:00Z',
              producteId: producteXaiId,
              unitatsDemanades: 2,
            },
          ],
        },
      });

      const perCategoria = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: `/api/v1/panells/empaquetat?categoriaId=${categoriaId}`,
        }),
      );
      expect(perCategoria.totals.linies).toBe(2);
      expect(perCategoria.dades.every((f) => f.categoria === 'XAI')).toBe(true);

      // Una de les dues passa a enviada.
      const primera = perCategoria.dades[0]!;
      await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${primera.comandaId}/linies/${primera.liniaId}/lliurament`,
        payload: { unitatsLliurades: 1, kgLliurats: '10.000' },
      });

      const url = `/api/v1/panells/empaquetat?categoriaId=${categoriaId}`;
      const pendents = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({ method: 'GET', url: `${url}&confirmacio=pendents` }),
      );
      expect(pendents.dades.map((f) => f.liniaId)).not.toContain(primera.liniaId);
      expect(pendents.totals.linies).toBe(1);
      expect(pendents.totals.liniesConfirmades).toBe(0);

      const confirmades = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({ method: 'GET', url: `${url}&confirmacio=confirmades` }),
      );
      expect(confirmades.dades.map((f) => f.liniaId)).toEqual([primera.liniaId]);
      expect(confirmades.totals.liniesPendents).toBe(0);

      const totes = cuerpoJson<PanellEmpaquetatApi>(await fastify.inject({ method: 'GET', url }));
      expect(totes.totals.linies).toBe(2);

      // Línies sense categoria (Llom de dalt): categoria null, no trenca res.
      const senseFiltre = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/empaquetat?mida=200' }),
      );
      expect(senseFiltre.dades.some((f) => f.categoria === null)).toBe(true);

      // producte repetible, com a /panells/obrador: OR entre valors.
      const perLlom = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/empaquetat?producte=Llom%20fresc%20de%20porc',
        }),
      );
      const dosProductes = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/empaquetat?producte=Llom%20fresc%20de%20porc&producte=xai%20en%20canal&mida=200',
        }),
      );
      expect(dosProductes.totals.linies).toBe(perLlom.totals.linies + 2);
      expect(new Set(dosProductes.dades.map((f) => f.producte))).toEqual(
        new Set(['Llom fresc de porc', 'Xai en canal']),
      );

      const invalid = await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/empaquetat?confirmacio=totes',
      });
      expect(invalid.statusCode).toBe(400);

      await fastify.close();
    });
  });

  describe("tasca 22 — GET /panells/empaquetat amb més d'un transportista", () => {
    it('?transportistaId= repetible: línies de qualsevol dels transportistes indicats', async () => {
      const fastify = construirServidor();

      const transportistes = await entorn.poolTest.query<{ id: string; id_seq: string }>(
        `INSERT INTO transportista (nom) VALUES ('T22-A'), ('T22-B'), ('T22-C') RETURNING id, id_seq`,
      );
      const [tA, tB, tC] = transportistes.rows;
      const comandes: number[] = [];
      for (const t of [tA!, tB!, tC!]) {
        const creada = await fastify.inject({
          method: 'POST',
          url: '/api/v1/comandes',
          payload: {
            dataComanda: '2026-08-01',
            dataLliurament: '2026-08-30T00:00:00Z',
            origen: 'manual',
            linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
          },
        });
        const id = cuerpoJson<{ id: number }>(creada).id;
        comandes.push(id);
        await entorn.poolTest.query(`UPDATE comanda SET transportista_id = $1 WHERE id_seq = $2`, [
          t.id,
          id,
        ]);
      }

      const dos = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: `/api/v1/panells/empaquetat?transportistaId=${tA!.id_seq}&transportistaId=${tB!.id_seq}&mida=200`,
        }),
      );
      expect(new Set(dos.dades.map((f) => f.comandaId))).toEqual(
        new Set([comandes[0], comandes[1]]),
      );
      expect(new Set(dos.dades.map((f) => f.transportista))).toEqual(new Set(['T22-A', 'T22-B']));

      // Un sol transportista segueix funcionant igual que abans.
      const un = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({
          method: 'GET',
          url: `/api/v1/panells/empaquetat?transportistaId=${tC!.id_seq}`,
        }),
      );
      expect(un.dades.map((f) => f.comandaId)).toEqual([comandes[2]]);

      const invalid = await fastify.inject({
        method: 'GET',
        url: `/api/v1/panells/empaquetat?transportistaId=${tA!.id_seq}&transportistaId=abc`,
      });
      expect(invalid.statusCode).toBe(400);

      await fastify.close();
    });
  });

  // Petició d'Ari (29/09/2026). Al final del fitxer a propòsit: el pedido
  // cancel·lat no altera els totals que comproven els tests d'abans.
  describe('estat cancellada — fora de tots els panells', () => {
    it('no surt a Oficina (ni als totals), Obrador ni Empaquetat; a Oficina sí amb ?estat=cancellada', async () => {
      const fastify = construirServidor();

      const creada = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          linies: [{ dataProduccio: '2026-08-01T00:00:00Z', producteId, unitatsDemanades: 1 }],
        },
      });
      const comandaId = cuerpoJson<{ id: number }>(creada).id;

      const oficinaAbans = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina?mida=200' }),
      );
      expect(oficinaAbans.dades.some((f) => f.comandaId === comandaId)).toBe(true);

      const cancel = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}`,
        payload: { estat: 'cancellada' },
      });
      expect(cancel.statusCode).toBe(200);
      expect(cuerpoJson<ComandaDetallApi>(cancel).estat).toBe('cancellada');

      const oficina = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/oficina?mida=200' }),
      );
      expect(oficina.dades.some((f) => f.comandaId === comandaId)).toBe(false);
      expect(oficina.totals.comandes).toBe(oficinaAbans.totals.comandes - 1);

      const nomesCancellades = cuerpoJson<PanellOficinaApi>(
        await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/oficina?estat=cancellada&mida=200',
        }),
      );
      expect(nomesCancellades.dades.map((f) => f.comandaId)).toEqual([comandaId]);

      const obrador = cuerpoJson<PanellObradorApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/obrador?mida=200' }),
      );
      expect(obrador.dades.some((f) => f.comandaId === comandaId)).toBe(false);

      const empaquetat = cuerpoJson<PanellEmpaquetatApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/panells/empaquetat?mida=200' }),
      );
      expect(empaquetat.dades.some((f) => f.comandaId === comandaId)).toBe(false);

      await fastify.close();
    });
  });
});
