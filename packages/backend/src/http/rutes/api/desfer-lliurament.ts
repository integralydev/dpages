import type { LliuramentDesferRespostaApi } from '@dpages/shared';
import type { FastifyInstance } from 'fastify';
import { pool } from '../../../db/pool.js';
import { crearGuardaModul, enviarConflicte, enviarNoTrobat, parsearIdPublic } from './comu.js';
import { reobrirSiTancada } from './estat-automatic.js';

/**
 * Issue #19 — hasta ahora confirmat_a/confirmat_per sólo se podían SETEAR
 * (ver lliurament.ts), nunca resetear: si se confirmaba una línea
 * equivocada no había forma de deshacerlo (el PATCH .../lliurament rechaza
 * 0 siempre, a propósito — regla real, no se toca). Mismo patrón de guard
 * que treball.ts (bloquear si la comanda está congelada), pero acá no hace
 * falta body: desfer siempre es la misma operación, no hay nada que
 * decidir. Endpoint separado en vez de un flag en el PATCH existente para
 * no mezclar dos validaciones muy distintas (confirmar exige
 * unitats/kg > 0; desfer no toca esos campos en absoluto).
 *
 * Decisión de negocio confirmada: unitats_lliurades/kg_lliurats NO se
 * tocan al deshacer — el usuario ve el último valor cargado y lo corrige,
 * no vuelve a escribir todo desde cero.
 */
export function registrarRutaDesferLliurament(fastify: FastifyInstance): void {
  fastify.patch(
    '/comandes/:comandaId/linies/:liniaId/lliurament/desfer',
    { preHandler: crearGuardaModul('panell-empaquetat') },
    async (req, reply) => {
      const params = req.params as { comandaId: string; liniaId: string };
      const comandaIdPublic = parsearIdPublic(params.comandaId);
      const liniaIdPublic = parsearIdPublic(params.liniaId);
      if (comandaIdPublic === null || liniaIdPublic === null) {
        return enviarNoTrobat(reply, 'Línia no trobada');
      }

      const comanda = await pool.query<{ id: string; congelat_a: Date | null }>(
        'SELECT id, congelat_a FROM comanda WHERE id_seq = $1',
        [comandaIdPublic],
      );
      if (!comanda.rows[0]) return enviarNoTrobat(reply, 'Comanda no trobada');
      if (comanda.rows[0].congelat_a !== null) {
        return enviarConflicte(reply, 'La comanda està congelada i ja no admet canvis');
      }

      const resultat = await pool.query<{ id_seq: string }>(
        `UPDATE comanda_linia SET
         confirmat_a = NULL,
         confirmat_per = NULL
       WHERE id_seq = $1 AND comanda_id = $2
       RETURNING id_seq`,
        [liniaIdPublic, comanda.rows[0].id],
      );
      if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Línia no trobada');

      // Tarea 16: ya no está todo entregado.
      await reobrirSiTancada(pool, comanda.rows[0].id);

      const resposta: LliuramentDesferRespostaApi = {
        liniaId: Number(resultat.rows[0].id_seq),
        comandaId: comandaIdPublic,
        confirmatA: null,
        confirmatPer: null,
      };
      return resposta;
    },
  );
}
