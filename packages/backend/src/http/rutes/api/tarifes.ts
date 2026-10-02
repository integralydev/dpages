import type { FilaMatriuTarifesApi, TarifaResumApi } from '@dpages/shared';
import type { FastifyInstance } from 'fastify';
import { pool } from '../../../db/pool.js';
import {
  construirPaginacio,
  crearGuardaModul,
  enviarConflicte,
  enviarNoTrobat,
  enviarValidacio,
  esViolacioCodiUnic,
  MODULS_OPERATIUS_APOYO,
  parsearIdPublic,
  parsearPaginacio,
  patroComencaPer,
  resolverCategoriaUuid,
  resolverProducteUuid,
  resolverTarifaUuid,
} from './comu.js';

export function registrarRutesTarifes(fastify: FastifyInstance): void {
  // Endpoint de referència (contrato §4.3 — consumit també des de
  // office/orders/client-tariffs per resoldre columnes de tarifa, ver
  // MODULS_OPERATIUS_APOYO a comu.ts): lectura oberta a qualsevol mòdul
  // operatiu, escriptura restringida a "tarifes" més avall.
  fastify.get(
    '/tarifes/matriu',
    { preHandler: crearGuardaModul(MODULS_OPERATIUS_APOYO) },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const { pagina, mida, offset } = parsearPaginacio(query);

      const condicions: string[] = [];
      const valors: unknown[] = [];

      if (typeof query.categoriaId === 'string') {
        const categoriaIdPublic = parsearIdPublic(query.categoriaId);
        if (categoriaIdPublic === null) {
          return enviarValidacio(reply, 'categoriaId ha de ser un enter');
        }
        const categoriaUuid = await resolverCategoriaUuid(pool, categoriaIdPublic);
        condicions.push(`p.categoria_id = $${valors.length + 1}`);
        valors.push(categoriaUuid ?? '00000000-0000-0000-0000-000000000000');
      }
      if (typeof query.cerca === 'string' && query.cerca.trim() !== '') {
        // Tasca 18: pel principi del text, mateix criteri que productes.ts.
        const n = valors.length + 1;
        condicions.push(
          `(LOWER(p.descripcio) LIKE LOWER($${n}) ESCAPE '\\' OR LOWER(p.codi) LIKE LOWER($${n}) ESCAPE '\\')`,
        );
        valors.push(patroComencaPer(query.cerca.trim()));
      }
      const where = condicions.length > 0 ? `WHERE ${condicions.join(' AND ')}` : '';

      const tarifes = await pool.query<{ id_seq: string; codi: string | null; nom: string }>(
        'SELECT id_seq, codi, nom FROM tarifa ORDER BY nom ASC',
      );
      const tarifesApi: TarifaResumApi[] = tarifes.rows.map((t) => ({
        id: Number(t.id_seq),
        codi: t.codi,
        nom: t.nom,
      }));

      const total = await pool.query<{ count: string }>(
        `SELECT count(*) FROM producte p ${where}`,
        valors,
      );
      const productes = await pool.query<{
        id: string;
        id_seq: string;
        codi: string | null;
        descripcio: string;
      }>(
        `SELECT p.id, p.id_seq, p.codi, p.descripcio FROM producte p ${where}
       ORDER BY p.descripcio ASC, p.id_seq ASC LIMIT $${valors.length + 1} OFFSET $${valors.length + 2}`,
        [...valors, mida, offset],
      );

      const idsProductes = productes.rows.map((p) => p.id);
      const preus =
        idsProductes.length > 0
          ? await pool.query<{ producte_id: string; tarifa_id_seq: string; preu: string }>(
              `SELECT tp.producte_id, t.id_seq AS tarifa_id_seq, tp.preu
             FROM tarifa_preu tp
             JOIN tarifa t ON t.id = tp.tarifa_id
             WHERE tp.producte_id = ANY($1)`,
              [idsProductes],
            )
          : { rows: [] };

      const preusPerProducte = new Map<string, Record<string, string | null>>();
      for (const producte of productes.rows) {
        const fila: Record<string, string | null> = {};
        for (const tarifa of tarifesApi) fila[String(tarifa.id)] = null;
        preusPerProducte.set(producte.id, fila);
      }
      for (const fila of preus.rows) {
        preusPerProducte.get(fila.producte_id)![fila.tarifa_id_seq] = fila.preu;
      }

      const dades: FilaMatriuTarifesApi[] = productes.rows.map((p) => ({
        producteId: Number(p.id_seq),
        codi: p.codi,
        descripcio: p.descripcio,
        preus: preusPerProducte.get(p.id)!,
      }));

      return {
        tarifes: tarifesApi,
        dades,
        paginacio: construirPaginacio(pagina, mida, Number(total.rows[0]?.count ?? 0)),
      };
    },
  );

  fastify.patch(
    '/tarifes/:tarifaId/preus/:producteId',
    { preHandler: crearGuardaModul('tarifes') },
    async (req, reply) => {
      const params = req.params as { tarifaId: string; producteId: string };
      const tarifaIdPublic = parsearIdPublic(params.tarifaId);
      const producteIdPublic = parsearIdPublic(params.producteId);
      if (tarifaIdPublic === null || producteIdPublic === null) return enviarNoTrobat(reply);

      const cos = req.body as Partial<{ preu: string }>;
      if (!cos.preu || !/^\d+(\.\d{1,2})?$/.test(cos.preu)) {
        return enviarValidacio(reply, 'El preu ha de ser un import vàlid (ex. "9.50")', [
          { camp: 'preu', missatge: 'ha de ser un import vàlid amb com a màxim 2 decimals' },
        ]);
      }

      const [tarifaUuid, producteUuid] = await Promise.all([
        resolverTarifaUuid(pool, tarifaIdPublic),
        resolverProducteUuid(pool, producteIdPublic),
      ]);
      if (tarifaUuid === null) return enviarNoTrobat(reply, 'Tarifa no trobada');
      if (producteUuid === null) return enviarNoTrobat(reply, 'Producte no trobat');

      await pool.query(
        `INSERT INTO tarifa_preu (tarifa_id, producte_id, preu)
       VALUES ($1, $2, $3)
       ON CONFLICT (tarifa_id, producte_id) DO UPDATE SET preu = EXCLUDED.preu, actualitzat_en = now()`,
        [tarifaUuid, producteUuid, cos.preu],
      );

      return { tarifaId: tarifaIdPublic, producteId: producteIdPublic, preu: cos.preu };
    },
  );

  // Camino de vuelta a "sin precio": el PATCH de arriba no acepta
  // null/vacío (siempre exige un decimal válido), así que una vez cargada
  // una celda no había forma de volver a que la cascada de
  // resolverPreuLinia (comandes.ts) cayera al precio de catálogo. Borra la
  // fila de tarifa_preu; no hace falta tocar la cascada, ya contempla "no
  // hay fila" (WHERE tarifa_id = $1 AND producte_id = $2 sin resultado).
  fastify.delete(
    '/tarifes/:tarifaId/preus/:producteId',
    { preHandler: crearGuardaModul('tarifes') },
    async (req, reply) => {
      const params = req.params as { tarifaId: string; producteId: string };
      const tarifaIdPublic = parsearIdPublic(params.tarifaId);
      const producteIdPublic = parsearIdPublic(params.producteId);
      if (tarifaIdPublic === null || producteIdPublic === null) return enviarNoTrobat(reply);

      const [tarifaUuid, producteUuid] = await Promise.all([
        resolverTarifaUuid(pool, tarifaIdPublic),
        resolverProducteUuid(pool, producteIdPublic),
      ]);
      if (tarifaUuid === null) return enviarNoTrobat(reply, 'Tarifa no trobada');
      if (producteUuid === null) return enviarNoTrobat(reply, 'Producte no trobat');

      // 404 si la celda nunca tuvo precio — mismo criterio que el resto del
      // proyecto (DELETE /categories/:id, DELETE /rendiments-porcs/:id,
      // DELETE de línea de pedido): ninguno es idempotente-204, todos 404
      // cuando no hay nada que borrar.
      const resultat = await pool.query<{ id: string }>(
        'DELETE FROM tarifa_preu WHERE tarifa_id = $1 AND producte_id = $2 RETURNING id',
        [tarifaUuid, producteUuid],
      );
      if (!resultat.rows[0]) {
        return enviarNoTrobat(reply, 'Aquest producte no té preu assignat en aquesta tarifa');
      }

      reply.code(204);
    },
  );

  fastify.post('/tarifes', { preHandler: crearGuardaModul('tarifes') }, async (req, reply) => {
    const cos = req.body as Partial<{ codi: string; nom: string }>;

    if (!cos.codi || cos.codi.trim() === '') {
      return enviarValidacio(reply, 'El codi és obligatori', [
        { camp: 'codi', missatge: 'és obligatori' },
      ]);
    }
    if (!cos.nom || cos.nom.trim() === '') {
      return enviarValidacio(reply, 'El nom és obligatori', [
        { camp: 'nom', missatge: 'és obligatori' },
      ]);
    }

    try {
      const inserit = await pool.query<{ id_seq: string; codi: string | null; nom: string }>(
        `INSERT INTO tarifa (codi, nom) VALUES ($1, $2) RETURNING id_seq, codi, nom`,
        [cos.codi.trim(), cos.nom.trim()],
      );
      const fila = inserit.rows[0]!;
      const tarifaApi: TarifaResumApi = { id: Number(fila.id_seq), codi: fila.codi, nom: fila.nom };
      reply.code(201);
      return tarifaApi;
    } catch (err) {
      if (esViolacioCodiUnic(err)) {
        return enviarConflicte(reply, `Ja existeix una tarifa amb el codi "${cos.codi}"`);
      }
      throw err;
    }
  });
}
