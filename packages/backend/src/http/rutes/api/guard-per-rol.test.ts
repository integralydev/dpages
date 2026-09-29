import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { construirServidor as construirServidorType } from '../../servidor.js';
import {
  type EntornTestApi,
  netejarEntornApi,
  type NomRolReal,
  prepararEntornApi,
  promoureARol,
} from './test-suport.js';

/**
 * B1 — verificación end-to-end del guard por módulo, endpoint por endpoint,
 * contra los 6 ROLES REALES de producción (confirmados por Gerardo), no
 * roles sintéticos. Un solo archivo, un solo esquema (ver el comentario de
 * `prepararEntornApi` en test-suport.ts: el pool singleton de `db/pool.ts`
 * sólo honra el search_path del PRIMER esquema abierto en el proceso —
 * repartir estos tests en varios archivos, cada uno con su propio
 * `prepararEntornApi`, hace que las peticiones HTTP reales terminen
 * ejecutándose contra el esquema equivocado en cuanto el pool ya abrió una
 * conexión para otro archivo).
 */
describe('API negoci — guard por módulo, contra los 6 roles reales (B1, hallazgo de seguridad)', () => {
  let entorn: EntornTestApi;
  let construirServidor: typeof construirServidorType;
  let comandaId: number;
  let liniaId: number;
  let liniaConfirmadaId: number;

  const TOTS_ELS_ROLS_REALS: NomRolReal[] = [
    'administrador',
    'general',
    'oficina',
    'obrador',
    'empaquetat',
    'produccio',
  ];

  beforeAll(async () => {
    entorn = await prepararEntornApi('guard-per-rol');
    construirServidor = entorn.construirServidor;

    const producte = await entorn.poolTest.query<{ id: string }>(
      `INSERT INTO producte (descripcio, tipus) VALUES ('Producte de prova', 'simple') RETURNING id`,
    );
    const comanda = await entorn.poolTest.query<{ id: string; id_seq: string }>(
      `INSERT INTO comanda (origen_id, data_comanda, data_lliurament)
       VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), '2026-08-01', '2026-08-30')
       RETURNING id, id_seq`,
    );
    comandaId = Number(comanda.rows[0]!.id_seq);
    const linia = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO comanda_linia (comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari, pes_calculat_kg)
       VALUES ($1, 0, $2, 1, '9.86', '1.250') RETURNING id_seq`,
      [comanda.rows[0]!.id, producte.rows[0]!.id],
    );
    liniaId = Number(linia.rows[0]!.id_seq);
    const liniaConfirmada = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO comanda_linia (comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari, pes_calculat_kg, confirmat_a)
       VALUES ($1, 1, $2, 1, '9.86', '1.250', now()) RETURNING id_seq`,
      [comanda.rows[0]!.id, producte.rows[0]!.id],
    );
    liniaConfirmadaId = Number(liniaConfirmada.rows[0]!.id_seq);
  });

  afterAll(() => netejarEntornApi(entorn));

  // ── Endpoints de "apoyo" (MODULS_OPERATIUS_APOYO, comu.ts): GET abierto a
  // cualquiera de los 5 módulos operativos. Los 6 roles reales tienen al
  // menos uno de esos 5 — ninguno queda bloqueado para leer. ────────────────
  describe('Endpoints de apoyo — GET accesible para los 6 roles reales', () => {
    const rutasApoyo = [
      '/categories',
      '/productes',
      '/tarifes/matriu',
      '/transportistes',
      '/clients',
    ];

    for (const ruta of rutasApoyo) {
      it.each(TOTS_ELS_ROLS_REALS)(`GET ${ruta} — rol %s`, async (rol) => {
        const fastify = construirServidor();
        await promoureARol(entorn, fastify, rol);

        const res = await fastify.inject({ method: 'GET', url: `/api/v1${ruta}` });
        expect(res.statusCode).toBe(200);

        await fastify.close();
      });
    }
  });

  // ── Escritura de los endpoints de apoyo: restringida al módulo dueño ─────
  describe('Endpoints de apoyo — escritura restringida al módulo dueño', () => {
    it('POST /categories: Obrador 403, Administrador 201', async () => {
      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'obrador');
      const resDenegat = await denegat.inject({
        method: 'POST',
        url: '/api/v1/categories',
        payload: { nom: `Sense permís ${randomUUID()}` },
      });
      expect(resDenegat.statusCode).toBe(403);
      expect(resDenegat.json()).toMatchObject({ error: { codi: 'SENSE_PERMIS' } });
      await denegat.close();

      const permes = construirServidor();
      await promoureARol(entorn, permes, 'administrador');
      const resPermes = await permes.inject({
        method: 'POST',
        url: '/api/v1/categories',
        payload: { nom: `Categoria ${randomUUID()}` },
      });
      expect(resPermes.statusCode).toBe(201);
      await permes.close();
    });

    it('POST /productes: Oficina 403, Administrador 201 (módulo "catalog")', async () => {
      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'oficina');
      const resDenegat = await denegat.inject({
        method: 'POST',
        url: '/api/v1/productes',
        payload: { descripcio: 'Sense permís', tipus: 'simple' },
      });
      expect(resDenegat.statusCode).toBe(403);
      await denegat.close();

      const permes = construirServidor();
      await promoureARol(entorn, permes, 'administrador');
      const resPermes = await permes.inject({
        method: 'POST',
        url: '/api/v1/productes',
        payload: { descripcio: 'Producte creat per Administrador', tipus: 'simple' },
      });
      expect(resPermes.statusCode).toBe(201);
      await permes.close();
    });

    it('POST /tarifes: Empaquetat 403, Administrador 201 (módulo "tarifes")', async () => {
      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'empaquetat');
      const resDenegat = await denegat.inject({
        method: 'POST',
        url: '/api/v1/tarifes',
        payload: { codi: `T-${randomUUID().slice(0, 6)}`, nom: 'Sense permís' },
      });
      expect(resDenegat.statusCode).toBe(403);
      await denegat.close();

      const permes = construirServidor();
      await promoureARol(entorn, permes, 'administrador');
      const resPermes = await permes.inject({
        method: 'POST',
        url: '/api/v1/tarifes',
        payload: { codi: `T-${randomUUID().slice(0, 6)}`, nom: 'Tarifa creada' },
      });
      expect(resPermes.statusCode).toBe(201);
      await permes.close();
    });

    it('POST /clients: Obrador 403, Administrador 201 (módulo "tarifes-clients")', async () => {
      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'obrador');
      const resDenegat = await denegat.inject({
        method: 'POST',
        url: '/api/v1/clients',
        payload: { nom: 'Sense permís', poblacio: 'Manresa' },
      });
      expect(resDenegat.statusCode).toBe(403);
      await denegat.close();

      const permes = construirServidor();
      await promoureARol(entorn, permes, 'administrador');
      const resPermes = await permes.inject({
        method: 'POST',
        url: '/api/v1/clients',
        payload: { nom: 'Client creat', poblacio: 'Manresa' },
      });
      expect(resPermes.statusCode).toBe(201);
      await permes.close();
    });

    // "transportistes" es el único módulo de escritura que NI General NI
    // Producció tienen (confirmado por Gerardo) — a diferencia de los otros
    // 4 recursos de apoyo de arriba, acá General debe quedar bloqueado.
    it('POST /transportistes: General 403 (no tiene el módulo), Administrador 201', async () => {
      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'general');
      const resDenegat = await denegat.inject({
        method: 'POST',
        url: '/api/v1/transportistes',
        payload: { nom: 'Sense permís' },
      });
      expect(resDenegat.statusCode).toBe(403);
      await denegat.close();

      const permes = construirServidor();
      await promoureARol(entorn, permes, 'administrador');
      const resPermes = await permes.inject({
        method: 'POST',
        url: '/api/v1/transportistes',
        payload: { nom: 'Transportista creat' },
      });
      expect(resPermes.statusCode).toBe(201);
      await permes.close();
    });
  });

  // ── comandes.ts: estricto, único módulo directo — Oficina es el único rol
  // real que lo combina con un panell. ─────────────────────────────────────
  describe('/comandes — estricto, módulo "comandes"', () => {
    it('GET /comandes accesible para Oficina, rechaza a Obrador y Empaquetat', async () => {
      const oficina = construirServidor();
      await promoureARol(entorn, oficina, 'oficina');
      expect((await oficina.inject({ method: 'GET', url: '/api/v1/comandes' })).statusCode).toBe(
        200,
      );
      await oficina.close();

      for (const rol of ['obrador', 'empaquetat'] as const) {
        const fastify = construirServidor();
        await promoureARol(entorn, fastify, rol);
        const res = await fastify.inject({ method: 'GET', url: '/api/v1/comandes' });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: { codi: 'SENSE_PERMIS' } });
        await fastify.close();
      }
    });

    it('POST /comandes rechaza con 403 a Producció antes de validar el body', async () => {
      const fastify = construirServidor();
      await promoureARol(entorn, fastify, 'obrador');

      const res = await fastify.inject({ method: 'POST', url: '/api/v1/comandes', payload: {} });
      expect(res.statusCode).toBe(403);

      await fastify.close();
    });
  });

  // ── Caso especial (investigación post-B1, hallazgo de Michelle): GET
  // /comandes y GET /comandes/:id aceptan 'comandes' O 'panell-oficina' —
  // POST/PATCH/DELETE siguen exigiendo 'comandes' en solitario. Ningún rol
  // real de hoy tiene panell-oficina SIN comandes (Oficina tiene los dos),
  // así que se simula acá un rol hipotético — la red de seguridad es para
  // un rol futuro de "oficina, sólo lectura" creado en vivo vía
  // RoleFormModal. No se agrega a ROLS_REALS (test-suport.ts): ese registro
  // es específicamente "los 6 roles reales de producción", no roles
  // hipotéticos. ──────────────────────────────────────────────────────────
  describe('GET /comandes(/:id) — lectura acotada, también abierta a panell-oficina en solitario', () => {
    const NOM_ROL_HIPOTETIC = 'Oficina (sols lectura, hipotètic)';

    async function promoureAOficinaSolsLectura(fastify: {
      inject: (opcions: { method: string; url: string }) => Promise<unknown>;
    }): Promise<void> {
      await fastify.inject({ method: 'GET', url: '/api/v1/jo' });
      await entorn.poolTest.query(
        `INSERT INTO rol (nom, moduls_permesos) VALUES ($1, ARRAY['panell-oficina'])
         ON CONFLICT (nom) DO UPDATE SET moduls_permesos = EXCLUDED.moduls_permesos`,
        [NOM_ROL_HIPOTETIC],
      );
      await entorn.poolTest.query(
        `UPDATE usuari SET rol_id = (SELECT id FROM rol WHERE nom = $1) WHERE firebase_uid = 'dev-sense-auth'`,
        [NOM_ROL_HIPOTETIC],
      );
    }

    it('GET /comandes y GET /comandes/:id: 200 con sólo panell-oficina (sin comandes)', async () => {
      const fastify = construirServidor();
      await promoureAOficinaSolsLectura(fastify);

      const resLlista = await fastify.inject({ method: 'GET', url: '/api/v1/comandes' });
      expect(resLlista.statusCode).toBe(200);

      const resDetall = await fastify.inject({
        method: 'GET',
        url: `/api/v1/comandes/${comandaId}`,
      });
      expect(resDetall.statusCode).toBe(200);

      await fastify.close();
    });

    it('POST/PATCH/DELETE sobre comandes y línies: 403 con sólo panell-oficina', async () => {
      const fastify = construirServidor();
      await promoureAOficinaSolsLectura(fastify);

      const resPost = await fastify.inject({
        method: 'POST',
        url: '/api/v1/comandes',
        payload: {},
      });
      expect(resPost.statusCode).toBe(403);
      expect(resPost.json()).toMatchObject({ error: { codi: 'SENSE_PERMIS' } });

      const resPatch = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}`,
        payload: { bultos: 3 },
      });
      expect(resPatch.statusCode).toBe(403);

      const resPostLinia = await fastify.inject({
        method: 'POST',
        url: `/api/v1/comandes/${comandaId}/linies`,
        payload: {},
      });
      expect(resPostLinia.statusCode).toBe(403);

      const resPatchLinia = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}/linies/${liniaId}`,
        payload: {},
      });
      expect(resPatchLinia.statusCode).toBe(403);

      const resDeleteLinia = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/comandes/${comandaId}/linies/${liniaId}`,
      });
      expect(resDeleteLinia.statusCode).toBe(403);

      await fastify.close();
    });
  });

  // ── panells.ts: un módulo estricto y distinto por endpoint ───────────────
  describe('/panells/* — un módulo estricto por panel, verificado cruzado', () => {
    it('GET /panells/oficina: Oficina 200, Obrador 403', async () => {
      const ok = construirServidor();
      await promoureARol(entorn, ok, 'oficina');
      expect((await ok.inject({ method: 'GET', url: '/api/v1/panells/oficina' })).statusCode).toBe(
        200,
      );
      await ok.close();

      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'obrador');
      const res = await denegat.inject({ method: 'GET', url: '/api/v1/panells/oficina' });
      expect(res.statusCode).toBe(403);
      await denegat.close();
    });

    it('GET /panells/obrador: Obrador 200, Empaquetat 403', async () => {
      const ok = construirServidor();
      await promoureARol(entorn, ok, 'obrador');
      expect((await ok.inject({ method: 'GET', url: '/api/v1/panells/obrador' })).statusCode).toBe(
        200,
      );
      await ok.close();

      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'empaquetat');
      const res = await denegat.inject({ method: 'GET', url: '/api/v1/panells/obrador' });
      expect(res.statusCode).toBe(403);
      await denegat.close();
    });

    it('GET /panells/empaquetat: Empaquetat 200, Oficina 403', async () => {
      const ok = construirServidor();
      await promoureARol(entorn, ok, 'empaquetat');
      expect(
        (await ok.inject({ method: 'GET', url: '/api/v1/panells/empaquetat' })).statusCode,
      ).toBe(200);
      await ok.close();

      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'oficina');
      const res = await denegat.inject({ method: 'GET', url: '/api/v1/panells/empaquetat' });
      expect(res.statusCode).toBe(403);
      await denegat.close();
    });

    it('GET /panells/produccio: Producció 200 (con nombrePorcs), Oficina 403', async () => {
      const ok = construirServidor();
      await promoureARol(entorn, ok, 'produccio');
      expect(
        (await ok.inject({ method: 'GET', url: '/api/v1/panells/produccio?nombrePorcs=1' }))
          .statusCode,
      ).toBe(200);
      await ok.close();

      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'oficina');
      const res = await denegat.inject({
        method: 'GET',
        url: '/api/v1/panells/produccio?nombrePorcs=1',
      });
      expect(res.statusCode).toBe(403);
      await denegat.close();
    });

    it('Administrador y General acceden a los 4 panells (tienen los 4 módulos)', async () => {
      for (const rol of ['administrador', 'general'] as const) {
        const fastify = construirServidor();
        await promoureARol(entorn, fastify, rol);
        for (const ruta of ['oficina', 'obrador', 'empaquetat']) {
          const res = await fastify.inject({ method: 'GET', url: `/api/v1/panells/${ruta}` });
          expect(res.statusCode).toBe(200);
        }
        const resProduccio = await fastify.inject({
          method: 'GET',
          url: '/api/v1/panells/produccio?nombrePorcs=1',
        });
        expect(resProduccio.statusCode).toBe(200);
        await fastify.close();
      }
    });
  });

  // ── treball.ts / lliurament.ts / desfer-lliurament.ts ────────────────────
  describe('Acciones de línea — treball (Obrador) y lliurament (Empaquetat)', () => {
    it('PATCH .../treball: Obrador 200, Empaquetat 403', async () => {
      const ok = construirServidor();
      await promoureARol(entorn, ok, 'obrador');
      const resOk = await ok.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}/linies/${liniaId}/treball`,
        payload: { marcat: true },
      });
      expect(resOk.statusCode).toBe(200);
      await ok.close();

      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'empaquetat');
      const resDenegat = await denegat.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}/linies/${liniaId}/treball`,
        payload: { marcat: false },
      });
      expect(resDenegat.statusCode).toBe(403);
      await denegat.close();
    });

    it('PATCH .../lliurament: Empaquetat 200, Obrador 403', async () => {
      const ok = construirServidor();
      await promoureARol(entorn, ok, 'empaquetat');
      const resOk = await ok.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}/linies/${liniaId}/lliurament`,
        payload: { unitatsLliurades: 1, kgLliurats: '1.250' },
      });
      expect(resOk.statusCode).toBe(200);
      await ok.close();

      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'obrador');
      const resDenegat = await denegat.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}/linies/${liniaId}/lliurament`,
        payload: { unitatsLliurades: 1, kgLliurats: '1.250' },
      });
      expect(resDenegat.statusCode).toBe(403);
      await denegat.close();
    });

    it('PATCH .../lliurament/desfer: Empaquetat 200, Obrador 403', async () => {
      const ok = construirServidor();
      await promoureARol(entorn, ok, 'empaquetat');
      const resOk = await ok.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}/linies/${liniaConfirmadaId}/lliurament/desfer`,
      });
      expect(resOk.statusCode).toBe(200);
      await ok.close();

      const denegat = construirServidor();
      await promoureARol(entorn, denegat, 'obrador');
      const resDenegat = await denegat.inject({
        method: 'PATCH',
        url: `/api/v1/comandes/${comandaId}/linies/${liniaConfirmadaId}/lliurament/desfer`,
      });
      expect(resDenegat.statusCode).toBe(403);
      await denegat.close();
    });
  });

  // ── rendiments-porcs.ts: estricto, no es dato de apoyo de ninguna otra
  // pantalla (confirmado por grep del frontend). ──────────────────────────
  describe('/rendiments-porcs — estricto, módulo propio', () => {
    it('accesible para Administrador, General y Producció', async () => {
      for (const rol of ['administrador', 'general', 'produccio'] as const) {
        const fastify = construirServidor();
        await promoureARol(entorn, fastify, rol);
        const res = await fastify.inject({ method: 'GET', url: '/api/v1/rendiments-porcs' });
        expect(res.statusCode).toBe(200);
        await fastify.close();
      }
    });

    it('rechaza con 403 a Oficina, Obrador y Empaquetat', async () => {
      for (const rol of ['oficina', 'obrador', 'empaquetat'] as const) {
        const fastify = construirServidor();
        await promoureARol(entorn, fastify, rol);
        const res = await fastify.inject({ method: 'GET', url: '/api/v1/rendiments-porcs' });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: { codi: 'SENSE_PERMIS' } });
        await fastify.close();
      }
    });
  });
});
