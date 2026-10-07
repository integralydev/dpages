import type { ProducteApi } from '@dpages/shared';
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
} from './comu.js';

type Format = 'SENCER' | 'TALLAT' | 'LLESCAT';
type Envasat = 'NORMAL' | 'NORMAL (pes)' | 'NORMAL (web)' | 'ESPECIAL';
const FORMATS: readonly Format[] = ['SENCER', 'TALLAT', 'LLESCAT'];
const ENVASATS: readonly Envasat[] = ['NORMAL', 'NORMAL (pes)', 'NORMAL (web)', 'ESPECIAL'];

function esFormatValid(valor: unknown): valor is Format {
  return typeof valor === 'string' && FORMATS.includes(valor as Format);
}
function esEnvasatValid(valor: unknown): valor is Envasat {
  return typeof valor === 'string' && ENVASATS.includes(valor as Envasat);
}

interface FilaProducte {
  id_seq: string;
  codi: string | null;
  descripcio: string;
  descripcio_venda: string | null;
  tipus: 'simple' | 'variable';
  pes_kg: string | null;
  preu_venda: string | null;
  actiu: boolean;
  categoria_id_seq: string | null;
  categoria_nom: string | null;
  agrupacio_produccio: string | null;
  format: Format | null;
  envasat: Envasat | null;
}

function aApi(fila: FilaProducte): ProducteApi {
  return {
    id: Number(fila.id_seq),
    codi: fila.codi,
    descripcio: fila.descripcio,
    descripcioVenda: fila.descripcio_venda,
    tipus: fila.tipus,
    pesKg: fila.pes_kg,
    preuVenda: fila.preu_venda,
    actiu: fila.actiu,
    categoria:
      fila.categoria_id_seq !== null && fila.categoria_nom !== null
        ? { id: Number(fila.categoria_id_seq), nom: fila.categoria_nom }
        : null,
    agrupacioProduccio: fila.agrupacio_produccio,
    format: fila.format,
    envasat: fila.envasat,
  };
}

const SELECT_PRODUCTE = `
  SELECT p.id_seq, p.codi, p.descripcio, p.descripcio_venda, p.tipus, p.pes_kg,
         p.preu_venda, p.actiu, c.id_seq AS categoria_id_seq, c.nom AS categoria_nom,
         p.agrupacio_produccio, p.format, p.envasat
  FROM producte p
  LEFT JOIN categoria_producte c ON c.id = p.categoria_id
`;

export function registrarRutesProductes(fastify: FastifyInstance): void {
  fastify.get(
    '/productes',
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
        // Categoría inexistente: 0 resultados, no un error — es un filtro válido que no matchea nada.
        condicions.push(`p.categoria_id = $${valors.length + 1}`);
        valors.push(categoriaUuid ?? '00000000-0000-0000-0000-000000000000');
      }
      if (query.tipus === 'simple' || query.tipus === 'variable') {
        condicions.push(`p.tipus = $${valors.length + 1}`);
        valors.push(query.tipus);
      }
      if (query.actiu === 'true' || query.actiu === 'false') {
        condicions.push(`p.actiu = $${valors.length + 1}`);
        valors.push(query.actiu === 'true');
      }
      if (typeof query.format === 'string' && query.format !== '') {
        if (!esFormatValid(query.format)) {
          return enviarValidacio(reply, `format ha de ser: ${FORMATS.join(', ')}`);
        }
        condicions.push(`p.format = $${valors.length + 1}`);
        valors.push(query.format);
      }
      if (typeof query.envasat === 'string' && query.envasat !== '') {
        if (!esEnvasatValid(query.envasat)) {
          return enviarValidacio(reply, `envasat ha de ser: ${ENVASATS.join(', ')}`);
        }
        condicions.push(`p.envasat = $${valors.length + 1}`);
        valors.push(query.envasat);
      }
      if (typeof query.agrupacioProduccio === 'string' && query.agrupacioProduccio.trim() !== '') {
        // Mismo criterio que rendiments-porcs.ts — regla 3.1 transversal:
        // coincidencia EXACTA, case-insensitive.
        condicions.push(`LOWER(p.agrupacio_produccio) = LOWER($${valors.length + 1})`);
        valors.push(query.agrupacioProduccio.trim());
      }
      if (typeof query.cerca === 'string' && query.cerca.trim() !== '') {
        // Tasca 18 (01/10/2026): coincidència pel PRINCIPI del text, no
        // substring — "llom" troba "Llom fresc" però no "Cap de llom"
        // (manté l'esperit de la regla 3.1). Abans era coincidència exacta,
        // i el llistat no filtrava mentre s'escrivia. Case-insensitive.
        const n = valors.length + 1;
        condicions.push(
          `(LOWER(p.descripcio) LIKE LOWER($${n}) ESCAPE '\\' OR LOWER(p.descripcio_venda) LIKE LOWER($${n}) ESCAPE '\\' OR LOWER(p.codi) LIKE LOWER($${n}) ESCAPE '\\')`,
        );
        valors.push(patroComencaPer(query.cerca.trim()));
      }

      const where = condicions.length > 0 ? `WHERE ${condicions.join(' AND ')}` : '';

      const total = await pool.query<{ count: string }>(
        `SELECT count(*) FROM producte p ${where}`,
        valors,
      );
      const files = await pool.query<FilaProducte>(
        `${SELECT_PRODUCTE} ${where} ORDER BY p.descripcio ASC, p.id_seq ASC LIMIT $${valors.length + 1} OFFSET $${valors.length + 2}`,
        [...valors, mida, offset],
      );

      return {
        dades: files.rows.map(aApi),
        paginacio: construirPaginacio(pagina, mida, Number(total.rows[0]?.count ?? 0)),
      };
    },
  );

  fastify.get(
    '/productes/:id',
    { preHandler: crearGuardaModul(MODULS_OPERATIUS_APOYO) },
    async (req, reply) => {
      const idPublic = parsearIdPublic((req.params as { id: string }).id);
      if (idPublic === null) return enviarNoTrobat(reply);

      const resultat = await pool.query<FilaProducte>(`${SELECT_PRODUCTE} WHERE p.id_seq = $1`, [
        idPublic,
      ]);
      if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Producte no trobat');
      return aApi(resultat.rows[0]);
    },
  );

  fastify.post('/productes', { preHandler: crearGuardaModul('catalog') }, async (req, reply) => {
    const cos = req.body as Partial<{
      codi: string | null;
      descripcio: string;
      descripcioVenda: string | null;
      tipus: 'simple' | 'variable';
      pesKg: string | null;
      preuVenda: string | null;
      actiu: boolean;
      categoriaId: number | null;
      agrupacioProduccio: string | null;
      format: Format | null;
      envasat: Envasat | null;
    }>;

    if (!cos.descripcio || cos.descripcio.trim() === '') {
      return enviarValidacio(reply, 'La descripció és obligatòria', [
        { camp: 'descripcio', missatge: 'és obligatòria' },
      ]);
    }
    if (cos.tipus !== undefined && cos.tipus !== 'simple' && cos.tipus !== 'variable') {
      return enviarValidacio(reply, 'tipus ha de ser "simple" o "variable"', [
        { camp: 'tipus', missatge: 'ha de ser "simple" o "variable"' },
      ]);
    }
    if (cos.format !== undefined && cos.format !== null && !esFormatValid(cos.format)) {
      return enviarValidacio(reply, `format ha de ser ${FORMATS.join(', ')} o null`, [
        { camp: 'format', missatge: `ha de ser ${FORMATS.join(', ')} o null` },
      ]);
    }
    if (cos.envasat !== undefined && cos.envasat !== null && !esEnvasatValid(cos.envasat)) {
      return enviarValidacio(reply, `envasat ha de ser ${ENVASATS.join(', ')} o null`, [
        { camp: 'envasat', missatge: `ha de ser ${ENVASATS.join(', ')} o null` },
      ]);
    }

    let categoriaUuid: string | null = null;
    if (cos.categoriaId !== undefined && cos.categoriaId !== null) {
      categoriaUuid = await resolverCategoriaUuid(pool, cos.categoriaId);
      if (categoriaUuid === null) {
        return enviarValidacio(reply, 'La categoria indicada no existeix', [
          { camp: 'categoriaId', missatge: 'no existeix' },
        ]);
      }
    }

    try {
      const insertat = await pool.query<FilaProducte>(
        `WITH nou AS (
           INSERT INTO producte (codi, descripcio, descripcio_venda, tipus, pes_kg, preu_venda, actiu,
                                  categoria_id, agrupacio_produccio, format, envasat)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *
         )
         SELECT nou.id_seq, nou.codi, nou.descripcio, nou.descripcio_venda, nou.tipus, nou.pes_kg,
                nou.preu_venda, nou.actiu, c.id_seq AS categoria_id_seq, c.nom AS categoria_nom,
                nou.agrupacio_produccio, nou.format, nou.envasat
         FROM nou LEFT JOIN categoria_producte c ON c.id = nou.categoria_id`,
        [
          cos.codi ?? null,
          cos.descripcio.trim(),
          cos.descripcioVenda ?? null,
          cos.tipus ?? 'simple',
          cos.pesKg ?? null,
          cos.preuVenda ?? null,
          cos.actiu ?? true,
          categoriaUuid,
          cos.agrupacioProduccio ?? null,
          cos.format ?? null,
          cos.envasat ?? null,
        ],
      );

      reply.code(201);
      return aApi(insertat.rows[0]!);
    } catch (err) {
      if (esViolacioCodiUnic(err)) {
        return enviarConflicte(reply, `Ja existeix un producte amb el codi "${cos.codi}"`);
      }
      throw err;
    }
  });

  fastify.patch(
    '/productes/:id',
    { preHandler: crearGuardaModul('catalog') },
    async (req, reply) => {
      const idPublic = parsearIdPublic((req.params as { id: string }).id);
      if (idPublic === null) return enviarNoTrobat(reply);

      // codi és immutable un cop creat el producte (decisió de negoci
      // confirmada: es carrega manualment NOMÉS en crear-lo). No es llegeix
      // del cos encara que vingui, no hi ha camp
      // per a ell acá — mateix criteri exacte que client.codi a
      // PATCH /clients/:id i usuari.firebaseUid a PATCH /usuaris/:id.
      const cos = req.body as Partial<{
        descripcio: string;
        descripcioVenda: string | null;
        tipus: 'simple' | 'variable';
        pesKg: string | null;
        preuVenda: string | null;
        actiu: boolean;
        categoriaId: number | null;
        agrupacioProduccio: string | null;
        format: Format | null;
        envasat: Envasat | null;
      }>;

      if (cos.descripcio !== undefined && cos.descripcio.trim() === '') {
        return enviarValidacio(reply, 'La descripció no pot estar buida', [
          { camp: 'descripcio', missatge: 'no pot estar buida' },
        ]);
      }
      if (cos.tipus !== undefined && cos.tipus !== 'simple' && cos.tipus !== 'variable') {
        return enviarValidacio(reply, 'tipus ha de ser "simple" o "variable"', [
          { camp: 'tipus', missatge: 'ha de ser "simple" o "variable"' },
        ]);
      }
      if (cos.format !== undefined && cos.format !== null && !esFormatValid(cos.format)) {
        return enviarValidacio(reply, `format ha de ser ${FORMATS.join(', ')} o null`, [
          { camp: 'format', missatge: `ha de ser ${FORMATS.join(', ')} o null` },
        ]);
      }
      if (cos.envasat !== undefined && cos.envasat !== null && !esEnvasatValid(cos.envasat)) {
        return enviarValidacio(reply, `envasat ha de ser ${ENVASATS.join(', ')} o null`, [
          { camp: 'envasat', missatge: `ha de ser ${ENVASATS.join(', ')} o null` },
        ]);
      }

      let categoriaUuid: string | null | undefined;
      if (cos.categoriaId !== undefined) {
        if (cos.categoriaId === null) {
          categoriaUuid = null;
        } else {
          categoriaUuid = await resolverCategoriaUuid(pool, cos.categoriaId);
          if (categoriaUuid === null) {
            return enviarValidacio(reply, 'La categoria indicada no existeix', [
              { camp: 'categoriaId', missatge: 'no existeix' },
            ]);
          }
        }
      }

      const resultat = await pool.query<{ id: string }>(
        `UPDATE producte SET
         descripcio = COALESCE($2, descripcio),
         descripcio_venda = CASE WHEN $3 THEN $4 ELSE descripcio_venda END,
         tipus = COALESCE($5, tipus),
         pes_kg = CASE WHEN $6 THEN $7 ELSE pes_kg END,
         preu_venda = CASE WHEN $8 THEN $9 ELSE preu_venda END,
         actiu = COALESCE($10, actiu),
         categoria_id = CASE WHEN $11 THEN $12 ELSE categoria_id END,
         agrupacio_produccio = CASE WHEN $13 THEN $14 ELSE agrupacio_produccio END,
         format = CASE WHEN $15 THEN $16 ELSE format END,
         envasat = CASE WHEN $17 THEN $18 ELSE envasat END
       WHERE id_seq = $1
       RETURNING id`,
        [
          idPublic,
          cos.descripcio?.trim() ?? null,
          cos.descripcioVenda !== undefined,
          cos.descripcioVenda ?? null,
          cos.tipus ?? null,
          cos.pesKg !== undefined,
          cos.pesKg ?? null,
          cos.preuVenda !== undefined,
          cos.preuVenda ?? null,
          cos.actiu ?? null,
          categoriaUuid !== undefined,
          categoriaUuid ?? null,
          cos.agrupacioProduccio !== undefined,
          cos.agrupacioProduccio ?? null,
          cos.format !== undefined,
          cos.format ?? null,
          cos.envasat !== undefined,
          cos.envasat ?? null,
        ],
      );

      if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Producte no trobat');

      const actualitzat = await pool.query<FilaProducte>(`${SELECT_PRODUCTE} WHERE p.id_seq = $1`, [
        idPublic,
      ]);
      return aApi(actualitzat.rows[0]!);
    },
  );
}
