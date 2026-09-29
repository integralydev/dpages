import type { TransportistaApi } from '@dpages/shared';
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
} from './comu.js';

interface FilaTransportista {
  id_seq: string;
  codi: string | null;
  nom: string;
  actiu: boolean;
}

function aApi(fila: FilaTransportista): TransportistaApi {
  return { id: Number(fila.id_seq), codi: fila.codi, nom: fila.nom, actiu: fila.actiu };
}

export function registrarRutesTransportistes(fastify: FastifyInstance): void {
  fastify.get(
    '/transportistes',
    { preHandler: crearGuardaModul(MODULS_OPERATIUS_APOYO) },
    async (req) => {
      const { pagina, mida, offset } = parsearPaginacio(req.query as Record<string, unknown>);

      const total = await pool.query<{ count: string }>('SELECT count(*) FROM transportista');
      const files = await pool.query<FilaTransportista>(
        'SELECT id_seq, codi, nom, actiu FROM transportista ORDER BY nom ASC, id_seq ASC LIMIT $1 OFFSET $2',
        [mida, offset],
      );

      return {
        dades: files.rows.map(aApi),
        paginacio: construirPaginacio(pagina, mida, Number(total.rows[0]?.count ?? 0)),
      };
    },
  );

  fastify.post(
    '/transportistes',
    { preHandler: crearGuardaModul('transportistes') },
    async (req, reply) => {
      const cos = req.body as Partial<{ nom: string; codi: string | null }>;

      if (!cos.nom || cos.nom.trim() === '') {
        return enviarValidacio(reply, 'El nom és obligatori', [
          { camp: 'nom', missatge: 'és obligatori' },
        ]);
      }

      try {
        const inserit = await pool.query<FilaTransportista>(
          `INSERT INTO transportista (nom, codi) VALUES ($1, $2)
         RETURNING id_seq, codi, nom, actiu`,
          [cos.nom.trim(), cos.codi ?? null],
        );
        reply.code(201);
        return aApi(inserit.rows[0]!);
      } catch (err) {
        if (esViolacioCodiUnic(err)) {
          return enviarConflicte(reply, `Ja existeix un transportista amb el codi "${cos.codi}"`);
        }
        throw err;
      }
    },
  );

  fastify.patch(
    '/transportistes/:id',
    { preHandler: crearGuardaModul('transportistes') },
    async (req, reply) => {
      const idPublic = parsearIdPublic((req.params as { id: string }).id);
      if (idPublic === null) return enviarNoTrobat(reply);

      const cos = req.body as Partial<{ nom: string; codi: string | null }>;

      if (cos.nom !== undefined && cos.nom.trim() === '') {
        return enviarValidacio(reply, 'El nom no pot estar buit', [
          { camp: 'nom', missatge: 'no pot estar buit' },
        ]);
      }

      try {
        const resultat = await pool.query<FilaTransportista>(
          `UPDATE transportista SET
           nom = COALESCE($2, nom),
           codi = CASE WHEN $3 THEN $4 ELSE codi END
         WHERE id_seq = $1
         RETURNING id_seq, codi, nom, actiu`,
          [idPublic, cos.nom?.trim() ?? null, cos.codi !== undefined, cos.codi ?? null],
        );
        if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Transportista no trobat');
        return aApi(resultat.rows[0]);
      } catch (err) {
        if (esViolacioCodiUnic(err)) {
          return enviarConflicte(reply, `Ja existeix un transportista amb el codi "${cos.codi}"`);
        }
        throw err;
      }
    },
  );
}
