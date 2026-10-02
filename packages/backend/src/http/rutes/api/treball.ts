import type { TreballLiniaRespostaApi } from '@dpages/shared';
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
import { construirFiltresObrador } from './panells.js';

/**
 * Panell Obrador no tenía forma de marcar una línea como "trabajada", a
 * diferencia de Empaquetat (`confirmat_a`/`confirmat_per`, ver
 * `lliurament.ts`). Mismo patrón de guard (bloquear si la comanda está
 * congelada) y mismo mecanismo para identificar al usuario autenticado
 * (`req.usuari.uid`, el uid de Firebase ya verificado por el middleware de
 * auth) — reusado, no reinventado.
 *
 * Diferencia deliberada con `confirmat_per` (TEXT, uid de Firebase crudo):
 * `treballat_per` es un UUID con FK real a `usuari(id)` (la tabla ya existe
 * — no había motivo para repetir la deuda técnica de `confirmat_per`, que
 * se diseñó ANTES de que `usuari` existiera y nunca se migró). Por eso acá
 * hace falta resolver el uid de Firebase a la fila de `usuari` con una
 * consulta propia — `req.usuariResolt.id` (ver resoldre-usuari.ts) es el id
 * PÚBLICO (id_seq), no el UUID interno, así que no sirve para el FK.
 */
export function registrarRutaTreball(fastify: FastifyInstance): void {
  fastify.patch(
    '/comandes/:comandaId/linies/:liniaId/treball',
    { preHandler: crearGuardaModul('panell-obrador') },
    async (req, reply) => {
      const params = req.params as { comandaId: string; liniaId: string };
      const comandaIdPublic = parsearIdPublic(params.comandaId);
      const liniaIdPublic = parsearIdPublic(params.liniaId);
      if (comandaIdPublic === null || liniaIdPublic === null) {
        return enviarNoTrobat(reply, 'Línia no trobada');
      }

      const cos = req.body as Partial<{ marcat: boolean }>;
      if (typeof cos.marcat !== 'boolean') {
        return enviarValidacio(reply, 'marcat és obligatori i ha de ser booleà', [
          { camp: 'marcat', missatge: 'és obligatori i ha de ser booleà' },
        ]);
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
      // se ejecutaría. Al desmarcar (marcat=false) no hace falta resolverlo:
      // treballat_per vuelve a NULL igual que treballat_a.
      let treballatPerUuid: string | null = null;
      if (cos.marcat) {
        const usuari = req.usuari!;
        const filaUsuari = await pool.query<{ id: string }>(
          'SELECT id FROM usuari WHERE firebase_uid = $1',
          [usuari.uid],
        );
        // El middleware de resolución de usuario (resoldre-usuari.ts) corre
        // ANTES de llegar acá y auto-provisiona la fila si es la primera vez
        // que se ve este uid — a esta altura siempre existe.
        treballatPerUuid = filaUsuari.rows[0]?.id ?? null;
      }

      const resultat = await pool.query<{ id_seq: string }>(
        `UPDATE comanda_linia SET
         treballat_a = CASE WHEN $3 THEN now() ELSE NULL END,
         treballat_per = CASE WHEN $3 THEN $4::uuid ELSE NULL END
       WHERE id_seq = $1 AND comanda_id = $2
       RETURNING id_seq`,
        [liniaIdPublic, comanda.rows[0].id, cos.marcat, treballatPerUuid],
      );
      if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Línia no trobada');

      // Releída de la base, no ecoada del body (a diferencia de
      // LliuramentRespostaApi.unitatsLliurades) — el JOIN resuelve
      // treballatPer a {id, nom} real, no sólo un uid de texto.
      const actualitzada = await pool.query<{
        id_seq: string;
        treballat_a: Date | null;
        treballat_per_id_seq: string | null;
        treballat_per_nom: string | null;
      }>(
        `SELECT cl.id_seq, cl.treballat_a,
              tu.id_seq AS treballat_per_id_seq, tu.nom AS treballat_per_nom
       FROM comanda_linia cl
       LEFT JOIN usuari tu ON tu.id = cl.treballat_per
       WHERE cl.id_seq = $1`,
        [liniaIdPublic],
      );
      const fila = actualitzada.rows[0]!;

      const resposta: TreballLiniaRespostaApi = {
        liniaId: Number(fila.id_seq),
        comandaId: comandaIdPublic,
        treballatA: formatearDataApi(fila.treballat_a),
        treballatPer:
          fila.treballat_per_id_seq !== null && fila.treballat_per_nom !== null
            ? { id: Number(fila.treballat_per_id_seq), nom: fila.treballat_per_nom }
            : null,
      };
      return resposta;
    },
  );

  // Tasca 26 (01/10/2026): marcar com a fetes, d'una vegada, TOTES les
  // línies pendents que compleixen els filtres actius del Panell Obrador
  // (els mateixos paràmetres de query que GET /panells/obrador, construïts
  // per la mateixa funció) — no només les de la pàgina visible. Les línies
  // de comandes congelades es deixen igual (mateix guard que el PATCH
  // individual) i es compten a part perquè el frontend pugui avisar-ho.
  fastify.post(
    '/panells/obrador/marcar-fets',
    { preHandler: crearGuardaModul('panell-obrador') },
    async (req, reply) => {
      const filtres = await construirFiltresObrador(reply, req.query as Record<string, unknown>);
      if (filtres === null) return;
      const { condicions, valors } = filtres;
      const where = [...condicions, 'cl.treballat_a IS NULL'].join(' AND ');

      // Mateix criteri que el PATCH individual: req.usuari sempre hi és i
      // resoldre-usuari.ts ja ha creat la fila d'usuari si calia.
      const filaUsuari = await pool.query<{ id: string }>(
        'SELECT id FROM usuari WHERE firebase_uid = $1',
        [req.usuari!.uid],
      );
      const treballatPerUuid = filaUsuari.rows[0]?.id ?? null;

      const congelades = await pool.query<{ n: string }>(
        `SELECT count(*) AS n
         FROM comanda_linia cl
         JOIN comanda c ON c.id = cl.comanda_id
         JOIN producte p ON p.id = cl.producte_id
         WHERE ${where} AND c.congelat_a IS NOT NULL`,
        valors,
      );
      const marcades = await pool.query<{ id_seq: string }>(
        `UPDATE comanda_linia AS cl
         SET treballat_a = now(), treballat_per = $${valors.length + 1}::uuid
         FROM comanda c, producte p
         WHERE c.id = cl.comanda_id AND p.id = cl.producte_id
           AND c.congelat_a IS NULL AND ${where}
         RETURNING cl.id_seq`,
        [...valors, treballatPerUuid],
      );

      return {
        marcades: marcades.rowCount ?? 0,
        congeladesOmeses: Number(congelades.rows[0]?.n ?? 0),
      };
    },
  );
}
