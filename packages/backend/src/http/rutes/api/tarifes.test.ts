import type { ComandaDetallApi, MatriuTarifesApi, TarifaResumApi } from '@dpages/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { construirServidor as construirServidorType } from '../../servidor.js';
import {
  cuerpoJson,
  type EntornTestApi,
  netejarEntornApi,
  prepararEntornApi,
} from './test-suport.js';

describe('API negoci — /tarifes (Postgres real, esquema aislado)', () => {
  let entorn: EntornTestApi;
  let construirServidor: typeof construirServidorType;
  let tarifaId: number;
  let producteId: number;

  beforeAll(async () => {
    entorn = await prepararEntornApi('tarifes');
    construirServidor = entorn.construirServidor;

    const producte = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO producte (codi, descripcio, tipus) VALUES ('LLF01', 'Llom fresc de porc', 'simple') RETURNING id_seq`,
    );
    producteId = Number(producte.rows[0]!.id_seq);
    const tarifa = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO tarifa (codi, nom) VALUES ('GEN', 'General') RETURNING id_seq`,
    );
    tarifaId = Number(tarifa.rows[0]!.id_seq);
  });

  afterAll(() => netejarEntornApi(entorn));

  it('GET /tarifes/matriu: sin precio cargado, la celda es null (no un error)', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/tarifes/matriu' });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<MatriuTarifesApi>(res);
    expect(cuerpo.tarifes).toEqual([
      { id: tarifaId, codi: 'GEN', nom: 'General', calculPerPes: true },
    ]);
    expect(cuerpo.dades[0]?.preus).toEqual({ [String(tarifaId)]: null });

    await fastify.close();
  });

  it('PATCH /tarifes/:tarifaId/preus/:producteId guarda una sola celda', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/tarifes/${tarifaId}/preus/${producteId}`,
      payload: { preu: '9.50' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tarifaId, producteId, preu: '9.50' });

    const matriu = await fastify.inject({ method: 'GET', url: '/api/v1/tarifes/matriu' });
    expect(cuerpoJson<MatriuTarifesApi>(matriu).dades[0]?.preus[String(tarifaId)]).toBe('9.50');

    await fastify.close();
  });

  it('PATCH con un preu mal formado rechaza con 400 VALIDACIO', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/tarifes/${tarifaId}/preus/${producteId}`,
      payload: { preu: 'no-es-un-numero' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { codi: 'VALIDACIO' } });

    await fastify.close();
  });

  it('PATCH con tarifa inexistente da 404 NO_TROBAT', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/tarifes/999999/preus/${producteId}`,
      payload: { preu: '9.50' },
    });

    expect(res.statusCode).toBe(404);

    await fastify.close();
  });

  describe('DELETE /tarifes/:tarifaId/preus/:producteId (capa 28)', () => {
    it('borra un precio existente: 204, la matriz vuelve a null, y una comanda nueva cae al precio de catàleg (no a 0 ni error)', async () => {
      const fastify = construirServidor();

      // Producto CON precio de catálogo propio — necesario para distinguir
      // "cayó a catálogo" de "quedó en 0.00 / sense preu" en la aserción
      // final. pes_kg fijo (fitxa) para no tener que mandar kgDemanats.
      const producte = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO producte (codi, descripcio, tipus, pes_kg, preu_venda)
         VALUES ('CAP28-P', 'Article amb preu de catàleg', 'simple', '1.000', '5.00') RETURNING id_seq`,
      );
      const producteCatalegId = Number(producte.rows[0]!.id_seq);

      const tarifaPropia = await entorn.poolTest.query<{ id_seq: string; id: string }>(
        `INSERT INTO tarifa (codi, nom) VALUES ('CAP28-T', 'Tarifa capa 28') RETURNING id_seq, id`,
      );
      const tarifaPropiaId = Number(tarifaPropia.rows[0]!.id_seq);

      const client = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO client (nom, poblacio, tarifa_id) VALUES ('Client capa 28', 'Vic', $1) RETURNING id_seq`,
        [tarifaPropia.rows[0]!.id],
      );
      const clientId = Number(client.rows[0]!.id_seq);

      // Precio de TARIFA distinto al de catálogo, para que las dos
      // aserciones (antes/después) no puedan confundirse entre sí.
      await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/tarifes/${tarifaPropiaId}/preus/${producteCatalegId}`,
        payload: { preu: '9.99' },
      });

      const abans = cuerpoJson<MatriuTarifesApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/tarifes/matriu' }),
      );
      expect(
        abans.dades.find((d) => d.producteId === producteCatalegId)?.preus[String(tarifaPropiaId)],
      ).toBe('9.99');

      const del = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/tarifes/${tarifaPropiaId}/preus/${producteCatalegId}`,
      });
      expect(del.statusCode).toBe(204);

      const despres = cuerpoJson<MatriuTarifesApi>(
        await fastify.inject({ method: 'GET', url: '/api/v1/tarifes/matriu' }),
      );
      expect(
        despres.dades.find((d) => d.producteId === producteCatalegId)?.preus[
          String(tarifaPropiaId)
        ],
      ).toBeNull();

      // La prueba real: una línea de pedido nueva con este cliente/producto
      // ya no encuentra tarifa_preu — la cascada (resolverPreuLinia) tiene
      // que caer al preu_venda de catálogo, no a "0.00 sense preu".
      const comanda = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          clientId,
          linies: [
            {
              dataProduccio: '2026-08-01T00:00:00Z',
              producteId: producteCatalegId,
              unitatsDemanades: 1,
            },
          ],
        },
      });
      expect(comanda.statusCode).toBe(201);
      const detall = cuerpoJson<ComandaDetallApi>(comanda);
      expect(detall.linies[0]?.preuUnitari).toBe('5.00');
      expect(detall.estat).toBe('oberta'); // no amb_incidencia: hubo precio real, no sensePreu

      await fastify.close();
    });

    it('borrar un precio que nunca existió da 404 NO_TROBAT (mismo criterio que el resto de DELETE del proyecto)', async () => {
      const producte = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO producte (codi, descripcio, tipus) VALUES ('CAP28-SP', 'Sense preu de tarifa', 'simple') RETURNING id_seq`,
      );
      const tarifa = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO tarifa (codi, nom) VALUES ('CAP28-T2', 'Tarifa capa 28 (b)') RETURNING id_seq`,
      );

      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/tarifes/${tarifa.rows[0]!.id_seq}/preus/${producte.rows[0]!.id_seq}`,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { codi: 'NO_TROBAT' } });

      await fastify.close();
    });

    it('borrar con tarifaId inexistente da 404 NO_TROBAT', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/tarifes/999999/preus/${producteId}`,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { codi: 'NO_TROBAT' } });

      await fastify.close();
    });

    it('borrar con producteId inexistente da 404 NO_TROBAT', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/tarifes/${tarifaId}/preus/999999`,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { codi: 'NO_TROBAT' } });

      await fastify.close();
    });
  });

  it('GET /tarifes/matriu: una tarifa vieja sin codi (NULL) no rompe la matriz ni desaparece del listado', async () => {
    // Reproduce el caso real: tarifas creadas antes de la migración 0010
    // (o cargadas a mano sin codi) conviven con las que sí lo tienen.
    const tarifaSinCodi = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO tarifa (nom) VALUES ('Tarifa Antiga Sense Codi') RETURNING id_seq`,
    );
    const tarifaSinCodiId = Number(tarifaSinCodi.rows[0]!.id_seq);

    const fastify = construirServidor();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/tarifes/matriu' });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<MatriuTarifesApi>(res);
    expect(cuerpo.tarifes).toContainEqual({
      id: tarifaSinCodiId,
      codi: null,
      nom: 'Tarifa Antiga Sense Codi',
      calculPerPes: true,
    });
    // La tarifa con codi (del beforeAll) sigue apareciendo igual, sin verse afectada.
    expect(cuerpo.tarifes).toContainEqual({
      id: tarifaId,
      codi: 'GEN',
      nom: 'General',
      calculPerPes: true,
    });

    await fastify.close();
  });

  it('POST /tarifes crea una tarifa nueva', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tarifes',
      payload: { codi: 'VIP', nom: 'Clients VIP' },
    });

    expect(res.statusCode).toBe(201);
    const cuerpo = cuerpoJson<TarifaResumApi>(res);
    // Tasca 40: si no es diu res, per pes.
    expect(cuerpo).toMatchObject({ codi: 'VIP', nom: 'Clients VIP', calculPerPes: true });

    await fastify.close();
  });

  it('POST /tarifes amb un codi ja existent da 409 CONFLICTE', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tarifes',
      payload: { codi: 'GEN', nom: 'Duplicada' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { codi: 'CONFLICTE' } });

    await fastify.close();
  });

  it('POST /tarifes sense codi da 400 VALIDACIO', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/tarifes',
      payload: { nom: 'Sense codi' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { codi: 'VALIDACIO' } });

    await fastify.close();
  });
  describe('tasca 40 — import per pes o per unitats segons la tarifa', () => {
    it('la comanda pren el càlcul de la tarifa en crear-se i en canviar-li la tarifa; canviar la tarifa no toca les comandes existents', async () => {
      const fastify = construirServidor();
      const producte = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO producte (codi, descripcio, tipus, pes_kg) VALUES ('T40-P', 'Article tasca 40', 'simple', '1.500') RETURNING id_seq`,
      );
      const t40ProducteId = Number(producte.rows[0]!.id_seq);

      async function crearTarifa(codi: string, calculPerPes?: boolean) {
        const res = await fastify.inject({
          method: 'POST',
          url: '/api/v1/tarifes',
          payload: {
            codi,
            nom: `Tarifa ${codi}`,
            ...(calculPerPes === undefined ? {} : { calculPerPes }),
          },
        });
        expect(res.statusCode).toBe(201);
        const tarifa = cuerpoJson<TarifaResumApi>(res);
        await fastify.inject({
          method: 'PATCH',
          url: `/api/v1/tarifes/${tarifa.id}/preus/${t40ProducteId}`,
          payload: { preu: '10.00' },
        });
        return tarifa;
      }
      async function crearComanda(tarifaIdComanda: number) {
        const res = await fastify.inject({
          method: 'POST',
          url: '/api/v1/comandes',
          payload: {
            dataComanda: '2026-08-01',
            dataLliurament: '2026-08-30T00:00:00Z',
            origen: 'manual',
            tarifaId: tarifaIdComanda,
            linies: [{ producteId: t40ProducteId, unitatsDemanades: 2 }],
          },
        });
        expect(res.statusCode).toBe(201);
        return cuerpoJson<ComandaDetallApi>(res);
      }
      const detall = async (id: number) =>
        cuerpoJson<ComandaDetallApi>(
          await fastify.inject({ method: 'GET', url: `/api/v1/comandes/${id}` }),
        );
      const totalGuardat = async (id: number) =>
        (
          await entorn.poolTest.query<{ total: string }>(
            'SELECT total FROM comanda WHERE id_seq = $1',
            [id],
          )
        ).rows[0]!.total;

      const perPes = await crearTarifa('T40-PES');
      const perUnitats = await crearTarifa('T40-UNI', false);
      expect(perPes.calculPerPes).toBe(true);
      expect(perUnitats.calculPerPes).toBe(false);

      // Per pes: 2 u × 1,5 kg = 3 kg × 10 € = 30 €.
      const a = await crearComanda(perPes.id);
      expect(a.calculPerPes).toBe(true);
      expect(a.linies[0]!.totalLinia).toBe('30.00');
      expect(a.totalEur).toBe('30.00');
      expect(await totalGuardat(a.id)).toBe('30.00');

      // Empaquetat confirma 2,5 kg: des d'aquí compten els kg lliurats.
      const lliurament = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${a.id}/linies/${a.linies[0]!.id}/lliurament`,
        payload: { unitatsLliurades: 2, kgLliurats: '2.500' },
      });
      expect(lliurament.statusCode).toBe(200);
      const aConfirmada = await detall(a.id);
      expect(aConfirmada.linies[0]!.totalLinia).toBe('25.00');
      expect(aConfirmada.totalEur).toBe('25.00');

      // Per unitats: 2 u × 10 € = 20 €.
      const b = await crearComanda(perUnitats.id);
      expect(b.calculPerPes).toBe(false);
      expect(b.totalEur).toBe('20.00');

      // Canviar el càlcul de la tarifa: la comanda A segueix per pes; una
      // de nova amb aquesta tarifa ja va per unitats.
      const canvi = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/tarifes/${perPes.id}`,
        payload: { calculPerPes: false },
      });
      expect(canvi.statusCode).toBe(200);
      expect(cuerpoJson<TarifaResumApi>(canvi).calculPerPes).toBe(false);
      expect((await detall(a.id)).totalEur).toBe('25.00');
      expect((await crearComanda(perPes.id)).totalEur).toBe('20.00');

      // Posar a B una tarifa per pes: B passa a calcular per pes.
      const perPes2 = await crearTarifa('T40-PES2');
      const canviTarifa = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${b.id}`,
        payload: { tarifaId: perPes2.id },
      });
      expect(canviTarifa.statusCode).toBe(200);
      const bDespres = await detall(b.id);
      expect(bDespres.calculPerPes).toBe(true);
      expect(bDespres.totalEur).toBe('30.00');

      await fastify.close();
    });

    it('sense tarifa a la comanda, pren el càlcul de la tarifa del client (la que dona el preu)', async () => {
      const fastify = construirServidor();
      const producte = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO producte (codi, descripcio, tipus, pes_kg) VALUES ('T40-C', 'Article tasca 40 client', 'simple', '2.000') RETURNING id_seq`,
      );
      const producteClientId = Number(producte.rows[0]!.id_seq);
      const tarifa = await entorn.poolTest.query<{ id: string; id_seq: string }>(
        `INSERT INTO tarifa (codi, nom) VALUES ('T40-CLI', 'Tarifa client per pes') RETURNING id, id_seq`,
      );
      await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/tarifes/${tarifa.rows[0]!.id_seq}/preus/${producteClientId}`,
        payload: { preu: '4.00' },
      });
      const client = await entorn.poolTest.query<{ id_seq: string }>(
        `INSERT INTO client (nom, poblacio, tarifa_id) VALUES ('Client tasca 40', 'Vic', $1) RETURNING id_seq`,
        [tarifa.rows[0]!.id],
      );

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {
          dataComanda: '2026-08-01',
          dataLliurament: '2026-08-30T00:00:00Z',
          origen: 'manual',
          clientId: Number(client.rows[0]!.id_seq),
          linies: [{ producteId: producteClientId, unitatsDemanades: 3 }],
        },
      });
      expect(res.statusCode).toBe(201);
      const comanda = cuerpoJson<ComandaDetallApi>(res);
      // 3 u × 2 kg = 6 kg × 4 € = 24 € (per unitats serien 12 €).
      expect(comanda.calculPerPes).toBe(true);
      expect(comanda.totalEur).toBe('24.00');
      await fastify.close();
    });

    it('PATCH /tarifes/:id valida calculPerPes i dona 404 si la tarifa no existeix', async () => {
      const fastify = construirServidor();
      const invalid = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/tarifes/${tarifaId}`,
        payload: { calculPerPes: 'si' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { codi: 'VALIDACIO' } });

      const noTrobada = await fastify.inject({
        method: 'PATCH',
        url: '/api/v1/tarifes/999999',
        payload: { calculPerPes: false },
      });
      expect(noTrobada.statusCode).toBe(404);
      await fastify.close();
    });
  });
});
