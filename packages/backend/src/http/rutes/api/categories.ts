import type { CategoriaApi } from '@dpages/shared';
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
  resolverCategoriaUuid,
} from './comu.js';

type AgrupacioRendiment = 'KG' | 'MAGRE' | 'PAQ';
const AGRUPACIONS_RENDIMENT: readonly AgrupacioRendiment[] = ['KG', 'MAGRE', 'PAQ'];

function esAgrupacioRendimentValida(valor: unknown): valor is AgrupacioRendiment {
  return typeof valor === 'string' && AGRUPACIONS_RENDIMENT.includes(valor as AgrupacioRendiment);
}

/**
 * Regla de negoci (no és un CHECK de base, ver migració 0011):
 * agrupacioRendiment només té sentit quan elaboratPorc és true. Compartida
 * entre POST (elaboratPorc ve al mateix cos) i PATCH (elaboratPorc pot no
 * venir — el valor EFECTIU s'ha de resoldre contra la fila actual abans de
 * cridar aquesta funció).
 */
function esCombinacioRendimentValida(
  elaboratPorcEfectiu: boolean,
  agrupacioRendiment: AgrupacioRendiment | null | undefined,
): boolean {
  if (agrupacioRendiment === undefined || agrupacioRendiment === null) return true;
  return elaboratPorcEfectiu;
}

interface FilaCategoria {
  id_seq: string;
  nom: string;
  elaborat_porc: boolean;
  agrupacio_rendiment: AgrupacioRendiment | null;
}

function aApi(fila: FilaCategoria): CategoriaApi {
  return {
    id: Number(fila.id_seq),
    nom: fila.nom,
    elaboratPorc: fila.elaborat_porc,
    agrupacioRendiment: fila.agrupacio_rendiment,
  };
}

export function registrarRutesCategories(fastify: FastifyInstance): void {
  // Endpoint de referència (contrato §4.1 — se consume desde catalog/pig-yields
  // además de esta pantalla): lectura abierta a cualquier módulo operativo,
  // nunca sólo a "categories" (ver MODULS_OPERATIUS_APOYO en comu.ts).
  fastify.get(
    '/categories',
    { preHandler: crearGuardaModul(MODULS_OPERATIUS_APOYO) },
    async (req) => {
      const { pagina, mida, offset } = parsearPaginacio(req.query as Record<string, unknown>);

      const total = await pool.query<{ count: string }>('SELECT count(*) FROM categoria_producte');
      const files = await pool.query<FilaCategoria>(
        `SELECT id_seq, nom, elaborat_porc, agrupacio_rendiment
       FROM categoria_producte ORDER BY nom ASC LIMIT $1 OFFSET $2`,
        [mida, offset],
      );

      return {
        dades: files.rows.map(aApi),
        paginacio: construirPaginacio(pagina, mida, Number(total.rows[0]?.count ?? 0)),
      };
    },
  );

  fastify.post(
    '/categories',
    { preHandler: crearGuardaModul('categories') },
    async (req, reply) => {
      const cos = req.body as Partial<{
        nom: string;
        elaboratPorc: boolean;
        agrupacioRendiment: AgrupacioRendiment | null;
      }>;

      if (!cos.nom || cos.nom.trim() === '') {
        return enviarValidacio(reply, 'El nom és obligatori', [
          { camp: 'nom', missatge: 'és obligatori' },
        ]);
      }
      if (
        cos.agrupacioRendiment !== undefined &&
        cos.agrupacioRendiment !== null &&
        !esAgrupacioRendimentValida(cos.agrupacioRendiment)
      ) {
        return enviarValidacio(
          reply,
          `agrupacioRendiment ha de ser ${AGRUPACIONS_RENDIMENT.join(', ')} o null`,
          [
            {
              camp: 'agrupacioRendiment',
              missatge: `ha de ser ${AGRUPACIONS_RENDIMENT.join(', ')} o null`,
            },
          ],
        );
      }

      const elaboratPorc = cos.elaboratPorc ?? false;
      if (!esCombinacioRendimentValida(elaboratPorc, cos.agrupacioRendiment)) {
        return enviarValidacio(
          reply,
          'agrupacioRendiment només es pot indicar quan elaboratPorc és true',
          [
            {
              camp: 'agrupacioRendiment',
              missatge: 'només aplica quan elaboratPorc és true',
            },
          ],
        );
      }

      try {
        const inserit = await pool.query<FilaCategoria>(
          `INSERT INTO categoria_producte (nom, elaborat_porc, agrupacio_rendiment)
         VALUES ($1, $2, $3)
         RETURNING id_seq, nom, elaborat_porc, agrupacio_rendiment`,
          [cos.nom.trim(), elaboratPorc, cos.agrupacioRendiment ?? null],
        );

        reply.code(201);
        return aApi(inserit.rows[0]!);
      } catch (err) {
        if (esViolacioCodiUnic(err)) {
          return enviarConflicte(reply, `Ja existeix una categoria amb el nom "${cos.nom}"`);
        }
        throw err;
      }
    },
  );

  fastify.patch(
    '/categories/:id',
    { preHandler: crearGuardaModul('categories') },
    async (req, reply) => {
      const idPublic = parsearIdPublic((req.params as { id: string }).id);
      if (idPublic === null) return enviarNoTrobat(reply);

      const cos = req.body as Partial<{
        nom: string;
        elaboratPorc: boolean;
        agrupacioRendiment: AgrupacioRendiment | null;
      }>;

      if (cos.nom !== undefined && cos.nom.trim() === '') {
        return enviarValidacio(reply, 'El nom no pot estar buit', [
          { camp: 'nom', missatge: 'no pot estar buit' },
        ]);
      }
      if (
        cos.agrupacioRendiment !== undefined &&
        cos.agrupacioRendiment !== null &&
        !esAgrupacioRendimentValida(cos.agrupacioRendiment)
      ) {
        return enviarValidacio(
          reply,
          `agrupacioRendiment ha de ser ${AGRUPACIONS_RENDIMENT.join(', ')} o null`,
          [
            {
              camp: 'agrupacioRendiment',
              missatge: `ha de ser ${AGRUPACIONS_RENDIMENT.join(', ')} o null`,
            },
          ],
        );
      }

      // Hace falta el valor EFECTIVO tras este PATCH — si elaboratPorc no
      // viene en el cuerpo, se compara contra el actual; de paso, esta
      // consulta resuelve si la categoría existe.
      if (cos.agrupacioRendiment !== undefined && cos.agrupacioRendiment !== null) {
        const actual = await pool.query<{ elaborat_porc: boolean }>(
          'SELECT elaborat_porc FROM categoria_producte WHERE id_seq = $1',
          [idPublic],
        );
        if (!actual.rows[0]) return enviarNoTrobat(reply, 'Categoria no trobada');

        const elaboratPorcEfectiu = cos.elaboratPorc ?? actual.rows[0].elaborat_porc;
        if (!esCombinacioRendimentValida(elaboratPorcEfectiu, cos.agrupacioRendiment)) {
          return enviarValidacio(
            reply,
            'agrupacioRendiment només es pot indicar quan elaboratPorc és true',
            [
              {
                camp: 'agrupacioRendiment',
                missatge: 'només aplica quan elaboratPorc és true',
              },
            ],
          );
        }
      }

      try {
        const resultat = await pool.query<FilaCategoria>(
          `UPDATE categoria_producte SET
           nom = COALESCE($2, nom),
           elaborat_porc = COALESCE($3, elaborat_porc),
           agrupacio_rendiment = CASE WHEN $4::boolean THEN $5 ELSE agrupacio_rendiment END
         WHERE id_seq = $1
         RETURNING id_seq, nom, elaborat_porc, agrupacio_rendiment`,
          [
            idPublic,
            cos.nom ?? null,
            cos.elaboratPorc ?? null,
            cos.agrupacioRendiment !== undefined,
            cos.agrupacioRendiment ?? null,
          ],
        );

        if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Categoria no trobada');
        return aApi(resultat.rows[0]);
      } catch (err) {
        if (esViolacioCodiUnic(err)) {
          return enviarConflicte(reply, `Ja existeix una categoria amb el nom "${cos.nom}"`);
        }
        throw err;
      }
    },
  );

  fastify.delete(
    '/categories/:id',
    { preHandler: crearGuardaModul('categories') },
    async (req, reply) => {
      const idPublic = parsearIdPublic((req.params as { id: string }).id);
      if (idPublic === null) return enviarNoTrobat(reply);

      const categoriaUuid = await resolverCategoriaUuid(pool, idPublic);
      if (categoriaUuid === null) return enviarNoTrobat(reply, 'Categoria no trobada');

      // Borrado protegido: CUALQUIER producto que la use bloquea el borrado,
      // esté activo o no — decisión de negocio: un producto inactivo
      // reactivado después no debe aparecer sin categoría sin que nadie lo
      // haya tocado directamente. Sin el filtro `actiu`, el recuento coincide
      // exactamente con lo que la FK producte.categoria_id (sin ON DELETE) va
      // a bloquear de todos modos — así el 409 se dispara ANTES del DELETE,
      // en vez de que Postgres lo rechace con un
      // unique_violation/foreign_key_violation que el handler no capturaba y
      // caía como 500 genérico (productos inactivos seguían bloqueando la FK
      // pero no este COUNT, que sólo miraba los activos).
      const enUs = await pool.query<{ count: string }>(
        'SELECT count(*) FROM producte WHERE categoria_id = $1',
        [categoriaUuid],
      );
      const total = Number(enUs.rows[0]?.count ?? 0);
      if (total > 0) {
        return enviarConflicte(
          reply,
          `No es pot eliminar: ${total} producte(s) fan servir aquesta categoria`,
        );
      }

      await pool.query('DELETE FROM categoria_producte WHERE id_seq = $1', [idPublic]);
      reply.code(204);
    },
  );
}
