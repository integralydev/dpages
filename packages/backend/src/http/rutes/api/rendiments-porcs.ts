import type { RendimentPorcApi } from '@dpages/shared';
import type { FastifyInstance } from 'fastify';
import { pool } from '../../../db/pool.js';
import {
  construirPaginacio,
  crearGuardaModul,
  enviarConflicte,
  enviarNoTrobat,
  enviarValidacio,
  esViolacioCodiUnic,
  parsearIdPublic,
  parsearPaginacio,
  resolverCategoriaUuid,
} from './comu.js';

// Guard estricto (B1): a diferencia de categories/productes/tarifes/
// transportistes/clients, este recurso NO es dato de apoyo de ninguna otra
// pantalla — confirmado con grep real del frontend (sólo pig-yields/page.tsx
// lo consume, vía usePigYields; Panell Producció calcula el rendimiento con
// SQL propio sobre la misma tabla, sin llamar a este endpoint HTTP).
const GUARD_RENDIMENTS_PORCS = crearGuardaModul('rendiments-porcs');

const REGEX_UNITATS_PER_PORC = /^\d+(\.\d{1,2})?$/;
const REGEX_KG_PER_UNITAT = /^\d+(\.\d{1,3})?$/;

interface FilaRendimentPorc {
  id_seq: string;
  agrupacio_rendiment: string;
  categoria_nom: string;
  agrupacio_produccio: string;
  unitats_per_porc: string;
  kg_per_unitat: string;
  pes_total: string;
}

// producte ya no viaja en la respuesta — ver la nota en RendimentPorcApi
// (packages/shared). Issues #3/#4: la fila ya no se identifica por
// producte_id/producte — agrupacio_produccio ahora es
// columna propia de rendiments_porcs (nunca null, es la identidad del
// grupo), no algo derivado de un producto puntual.
function aApi(fila: FilaRendimentPorc): RendimentPorcApi {
  return {
    id: Number(fila.id_seq),
    agrupacioRendiment: fila.agrupacio_rendiment,
    categoria: fila.categoria_nom,
    agrupacioProduccio: fila.agrupacio_produccio,
    unitatsPerPorc: fila.unitats_per_porc,
    kgPerUnitat: fila.kg_per_unitat,
    pesTotal: fila.pes_total,
  };
}

// INNER JOIN a categoria_producte + `cat.agrupacio_rendiment IS NOT NULL`:
// RendimentPorcApi.agrupacioRendiment/categoria son no-nulos, pero
// categoria_producte.agrupacio_rendiment sólo tiene valor cuando
// elaborat_porc es true (migració 0011) — la UNIQUE de rendiments_porcs no
// impide crear una fila contra una categoria SIN agrupació de rendiment
// (issue #4: esa validación es de negocio, no de esquema, ver el POST más
// abajo). Una fila así queda fuera del listado en vez de romper el
// contrato con un `null` donde el tipo no lo admite.
const SELECT_RENDIMENT = `
  SELECT r.id_seq, cat.agrupacio_rendiment,
         cat.nom AS categoria_nom, r.agrupacio_produccio,
         r.unitats_per_porc, r.kg_per_unitat,
         (r.unitats_per_porc * r.kg_per_unitat)::NUMERIC(10,3) AS pes_total
  FROM rendiments_porcs r
  JOIN categoria_producte cat ON cat.id = r.categoria_id
`;

export function registrarRutesRendimentsPorcs(fastify: FastifyInstance): void {
  fastify.get('/rendiments-porcs', { preHandler: GUARD_RENDIMENTS_PORCS }, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const { pagina, mida, offset } = parsearPaginacio(query);

    const condicions: string[] = ['cat.agrupacio_rendiment IS NOT NULL'];
    const valors: unknown[] = [];

    if (typeof query.agrupacioRendiment === 'string' && query.agrupacioRendiment !== '') {
      condicions.push(`cat.agrupacio_rendiment = $${valors.length + 1}`);
      valors.push(query.agrupacioRendiment);
    }
    if (typeof query.categoria === 'string' && query.categoria !== '') {
      condicions.push(`cat.nom = $${valors.length + 1}`);
      valors.push(query.categoria);
    }
    if (typeof query.categoriaId === 'string') {
      // Issues #3/#4 — reemplaza a ?producte=: ahora que la fila se
      // identifica por categoriaId + agrupacioProduccio, este es el filtro
      // EXACTO que hace falta para el chequeo de duplicado antes de crear
      // (mismo caso de uso que ?producte= cubría antes, pero preciso: ya no
      // depende de que exista un producte con esa descripció).
      const categoriaIdPublic = parsearIdPublic(query.categoriaId);
      if (categoriaIdPublic === null) {
        return enviarValidacio(reply, 'categoriaId ha de ser un enter');
      }
      const categoriaUuid = await resolverCategoriaUuid(pool, categoriaIdPublic);
      condicions.push(`r.categoria_id = $${valors.length + 1}`);
      valors.push(categoriaUuid ?? '00000000-0000-0000-0000-000000000000');
    }
    if (typeof query.agrupacioProduccio === 'string' && query.agrupacioProduccio.trim() !== '') {
      // Mismo criterio (regla 3.1 transversal): coincidencia EXACTA,
      // case-insensitive. Issues #3/#4: ahora es columna propia de
      // rendiments_porcs (r.agrupacio_produccio), ya no se llega a ella vía producte.
      condicions.push(`LOWER(r.agrupacio_produccio) = LOWER($${valors.length + 1})`);
      valors.push(query.agrupacioProduccio.trim());
    }

    const where = `WHERE ${condicions.join(' AND ')}`;

    const total = await pool.query<{ count: string }>(
      `SELECT count(*) FROM rendiments_porcs r
       JOIN categoria_producte cat ON cat.id = r.categoria_id
       ${where}`,
      valors,
    );
    const files = await pool.query<FilaRendimentPorc>(
      `${SELECT_RENDIMENT} ${where} ORDER BY r.agrupacio_produccio ASC, r.id_seq ASC LIMIT $${valors.length + 1} OFFSET $${valors.length + 2}`,
      [...valors, mida, offset],
    );

    return {
      dades: files.rows.map(aApi),
      paginacio: construirPaginacio(pagina, mida, Number(total.rows[0]?.count ?? 0)),
    };
  });

  fastify.post('/rendiments-porcs', { preHandler: GUARD_RENDIMENTS_PORCS }, async (req, reply) => {
    // Issues #3/#4 — la fila se identifica por categoriaId +
    // agrupacioProduccio, no por producteId — el rendimiento de un cerdo se
    // define a nivel de Agrupació Producció, no de artículo individual.
    const cos = req.body as Partial<{
      categoriaId: number;
      agrupacioProduccio: string;
      unitatsPerPorc: string;
      kgPerUnitat: string;
    }>;

    if (cos.categoriaId === undefined || !Number.isInteger(cos.categoriaId)) {
      return enviarValidacio(reply, 'categoriaId és obligatori', [
        { camp: 'categoriaId', missatge: 'és obligatori' },
      ]);
    }
    const agrupacioProduccio = cos.agrupacioProduccio?.trim();
    if (!agrupacioProduccio) {
      return enviarValidacio(reply, 'agrupacioProduccio és obligatori', [
        { camp: 'agrupacioProduccio', missatge: 'és obligatori' },
      ]);
    }
    if (!cos.unitatsPerPorc || !REGEX_UNITATS_PER_PORC.test(cos.unitatsPerPorc)) {
      return enviarValidacio(reply, 'unitatsPerPorc ha de ser un número vàlid (ex. "2.00")', [
        {
          camp: 'unitatsPerPorc',
          missatge: 'ha de ser un número vàlid amb com a màxim 2 decimals',
        },
      ]);
    }
    if (!cos.kgPerUnitat || !REGEX_KG_PER_UNITAT.test(cos.kgPerUnitat)) {
      return enviarValidacio(reply, 'kgPerUnitat ha de ser un número vàlid (ex. "3.500")', [
        { camp: 'kgPerUnitat', missatge: 'ha de ser un número vàlid amb com a màxim 3 decimals' },
      ]);
    }

    const categoria = await pool.query<{ id: string; agrupacio_rendiment: string | null }>(
      `SELECT id, agrupacio_rendiment FROM categoria_producte WHERE id_seq = $1`,
      [cos.categoriaId],
    );
    if (!categoria.rows[0]) {
      return enviarValidacio(reply, 'La categoria indicada no existeix', [
        { camp: 'categoriaId', missatge: 'no existeix' },
      ]);
    }
    if (categoria.rows[0].agrupacio_rendiment === null) {
      return enviarValidacio(reply, 'La categoria indicada no té agrupació de rendiment definida', [
        { camp: 'categoriaId', missatge: 'no té agrupació de rendiment' },
      ]);
    }

    // Validación necesaria, no cosmética: panells.ts hace JOIN
    // rp.categoria_id = p.categoria_id AND rp.agrupacio_produccio =
    // p.agrupacio_produccio, comparación de texto EXACTA (case-sensitive,
    // sin trim de por medio). Si agrupacioProduccio viene con un typo que no
    // coincide con ningún producte real, la fila queda huérfana y el join de
    // panells.ts nunca la encuentra — el mismo tipo de fallo silencioso que
    // esta migración existe para eliminar, sólo que por typo en vez de por
    // desempate de id_seq.
    const grupoExiste = await pool.query(
      `SELECT 1 FROM producte WHERE categoria_id = $1 AND agrupacio_produccio = $2 LIMIT 1`,
      [categoria.rows[0].id, agrupacioProduccio],
    );
    if (!grupoExiste.rows[0]) {
      return enviarValidacio(
        reply,
        'No existeix cap producte amb aquesta categoria i agrupació de producció',
        [
          {
            camp: 'agrupacioProduccio',
            missatge: "no coincideix amb cap producte real d'aquesta categoria",
          },
        ],
      );
    }

    try {
      const inserit = await pool.query<{ id_seq: string }>(
        `INSERT INTO rendiments_porcs (categoria_id, agrupacio_produccio, unitats_per_porc, kg_per_unitat)
         VALUES ($1, $2, $3, $4) RETURNING id_seq`,
        [categoria.rows[0].id, agrupacioProduccio, cos.unitatsPerPorc, cos.kgPerUnitat],
      );

      const creat = await pool.query<FilaRendimentPorc>(`${SELECT_RENDIMENT} WHERE r.id_seq = $1`, [
        inserit.rows[0]!.id_seq,
      ]);

      reply.code(201);
      return aApi(creat.rows[0]!);
    } catch (err) {
      // UNIQUE (categoria_id, agrupacio_produccio) — migración de esquema,
      // ya no una advertencia tolerada (antes de esta migración no había
      // restricción real a nivel de base para esto).
      if (esViolacioCodiUnic(err)) {
        return enviarConflicte(
          reply,
          `Ja existeix un rendiment per a aquesta categoria i agrupació de producció ("${agrupacioProduccio}")`,
        );
      }
      throw err;
    }
  });

  fastify.patch(
    '/rendiments-porcs/:id',
    { preHandler: GUARD_RENDIMENTS_PORCS },
    async (req, reply) => {
      const idPublic = parsearIdPublic((req.params as { id: string }).id);
      if (idPublic === null) return enviarNoTrobat(reply);

      // categoriaId/agrupacioProduccio són immutables un cop creada la fila
      // (issues #3/#4 — mateix criteri que producteId abans d'aquesta
      // migració, i que codi a PATCH /clients/:id): no es llegeixen del cos
      // encara que vinguin, no hi ha camp per a ells acà.
      const cos = req.body as Partial<{ unitatsPerPorc: string; kgPerUnitat: string }>;

      if (
        cos.unitatsPerPorc !== undefined &&
        (!cos.unitatsPerPorc || !REGEX_UNITATS_PER_PORC.test(cos.unitatsPerPorc))
      ) {
        return enviarValidacio(reply, 'unitatsPerPorc ha de ser un número vàlid (ex. "2.00")', [
          {
            camp: 'unitatsPerPorc',
            missatge: 'ha de ser un número vàlid amb com a màxim 2 decimals',
          },
        ]);
      }
      if (
        cos.kgPerUnitat !== undefined &&
        (!cos.kgPerUnitat || !REGEX_KG_PER_UNITAT.test(cos.kgPerUnitat))
      ) {
        return enviarValidacio(reply, 'kgPerUnitat ha de ser un número vàlid (ex. "3.500")', [
          { camp: 'kgPerUnitat', missatge: 'ha de ser un número vàlid amb com a màxim 3 decimals' },
        ]);
      }

      const resultat = await pool.query<{ id: string }>(
        `UPDATE rendiments_porcs SET
         unitats_per_porc = COALESCE($2, unitats_per_porc),
         kg_per_unitat = COALESCE($3, kg_per_unitat)
       WHERE id_seq = $1
       RETURNING id`,
        [idPublic, cos.unitatsPerPorc ?? null, cos.kgPerUnitat ?? null],
      );
      if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Rendiment no trobat');

      const actualitzat = await pool.query<FilaRendimentPorc>(
        `${SELECT_RENDIMENT} WHERE r.id_seq = $1`,
        [idPublic],
      );
      return aApi(actualitzat.rows[0]!);
    },
  );

  fastify.delete(
    '/rendiments-porcs/:id',
    { preHandler: GUARD_RENDIMENTS_PORCS },
    async (req, reply) => {
      const idPublic = parsearIdPublic((req.params as { id: string }).id);
      if (idPublic === null) return enviarNoTrobat(reply);

      const resultat = await pool.query<{ id: string }>(
        'DELETE FROM rendiments_porcs WHERE id_seq = $1 RETURNING id',
        [idPublic],
      );
      if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Rendiment no trobat');

      reply.code(204);
    },
  );
}
