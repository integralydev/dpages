import type { LliuramentRespostaApi } from '@dpages/shared';
import type { FastifyInstance } from 'fastify';
import { pool } from '../../../db/pool.js';
import {
  crearGuardaModul,
  enviarConflicte,
  enviarNoTrobat,
  enviarValidacio,
  formatearDataApi,
  parsearIdPublic,
} from './comu.js';
import { tancarSiTotLliurat } from './estat-automatic.js';

/**
 * El endpoint más delicado del sistema (contrato, sección 5): unitats i kg
 * lliurats son OBLIGATORIOS, aunque coincidan con lo pedido — es doble
 * confirmación deliberada (mermas → abono/cargo). Una sola llamada
 * confirma Y graba; no hay un paso previo de "guardar sin confirmar".
 *
 * Issue #19 — estos dos campos SÍ pueden valer 0 (rotura total, artículo
 * agotado, etc. son casos reales de negocio con 0 entregado). Por eso la
 * validación de acá NO reusa `esUnitatsValides` de `comu.js` — esa función
 * es compartida con `unitatsDemanades` (`POST /comandes`,
 * `POST .../linies`, `PATCH .../linies/:liniaId`), cuya regla de "mayor que
 * cero" sigue vigente (una línea de pedido no puede pedirse en cero). Se
 * valida acá con lógica inline propia, mismo criterio que ya usaba
 * `kgLliurats`.
 */
export function registrarRutaLliurament(fastify: FastifyInstance): void {
  fastify.patch(
    '/comandes/:comandaId/linies/:liniaId/lliurament',
    { preHandler: crearGuardaModul('panell-empaquetat') },
    async (req, reply) => {
      const params = req.params as { comandaId: string; liniaId: string };
      const comandaIdPublic = parsearIdPublic(params.comandaId);
      const liniaIdPublic = parsearIdPublic(params.liniaId);
      if (comandaIdPublic === null || liniaIdPublic === null) {
        return enviarNoTrobat(reply, 'Línia no trobada');
      }

      const cos = req.body as Partial<{ unitatsLliurades: number; kgLliurats: string }>;
      const detalls: { camp: string; missatge: string }[] = [];

      // unitats_lliurades es NUMERIC(10,2): admite decimales (entregas
      // parciales de pieza), hasta 2 decimales.
      //
      // No exige > 0 (0 es válido, ver JSDoc de arriba): validación inline en
      // vez de `esUnitatsValides` (compartida con `unitatsDemanades`, que
      // sigue exigiendo > 0).
      const unitatsLliurades = cos.unitatsLliurades;
      const unitatsLliuradesValides =
        typeof unitatsLliurades === 'number' &&
        Number.isFinite(unitatsLliurades) &&
        unitatsLliurades >= 0 &&
        Math.round(unitatsLliurades * 100) / 100 === unitatsLliurades;
      if (unitatsLliurades === undefined || !unitatsLliuradesValides) {
        detalls.push({
          camp: 'unitatsLliurades',
          missatge: 'ha de ser un número vàlid (0 o més), com a màxim 2 decimals',
        });
      }
      const kgLliurats = cos.kgLliurats !== undefined ? Number(cos.kgLliurats) : NaN;
      if (cos.kgLliurats === undefined || !Number.isFinite(kgLliurats) || kgLliurats < 0) {
        detalls.push({ camp: 'kgLliurats', missatge: 'ha de ser un número vàlid (0 o més)' });
      }
      if (detalls.length > 0) {
        return enviarValidacio(reply, 'Les unitats i els kg lliurats no són vàlids', detalls);
      }

      const comanda = await pool.query<{ id: string; congelat_a: Date | null }>(
        'SELECT id, congelat_a FROM comanda WHERE id_seq = $1',
        [comandaIdPublic],
      );
      if (!comanda.rows[0]) return enviarNoTrobat(reply, 'Comanda no trobada');
      if (comanda.rows[0].congelat_a !== null) {
        return enviarConflicte(reply, 'La comanda està congelada i ja no admet canvis');
      }

      // El middleware de auth (ADR-021) siempre lo deja seteado antes de
      // llegar acá — si faltara, ya habría respondido 401 y este handler ni
      // se ejecutaría.
      const usuari = req.usuari!;

      const resultat = await pool.query<{ id_seq: string; confirmat_a: Date }>(
        `UPDATE comanda_linia SET
         unitats_lliurades = $3,
         kg_lliurats = $4,
         confirmat_a = now(),
         confirmat_per = $5
       WHERE id_seq = $1 AND comanda_id = $2
       RETURNING id_seq, confirmat_a`,
        [liniaIdPublic, comanda.rows[0].id, cos.unitatsLliurades, cos.kgLliurats, usuari.uid],
      );
      if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Línia no trobada');

      // Tarea 16: si era la última línea pendiente, la comanda se cierra.
      await tancarSiTotLliurat(pool, comanda.rows[0].id);

      // El middleware (resoldre-usuari.ts) deja el usuario real resuelto en
      // req.usuariResolt, así que id/nom no son un marcador.
      const usuariResolt = req.usuariResolt!;
      const resposta: LliuramentRespostaApi = {
        liniaId: Number(resultat.rows[0].id_seq),
        comandaId: comandaIdPublic,
        // unitatsLliurades es NUMERIC(10,2) → se expone como string. No se
        // vuelve a leer de la base en este mismo endpoint (se graba y se
        // devuelve el valor recibido tal cual) — se formatea acá a mano con 2
        // decimales para que la respuesta sea igual de consistente que si
        // viniera de un SELECT posterior (mismo criterio que kgLliurats, que
        // ya era string).
        unitatsLliurades: cos.unitatsLliurades!.toFixed(2),
        kgLliurats: cos.kgLliurats!,
        confirmatA: formatearDataApi(resultat.rows[0].confirmat_a)!,
        confirmatPer: { id: usuariResolt.id, nom: usuariResolt.nom },
      };
      return resposta;
    },
  );
}
