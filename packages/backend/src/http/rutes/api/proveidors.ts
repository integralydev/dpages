import type { ProveidorApi } from '@dpages/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../../../db/pool.js';
import {
  construirPaginacio,
  crearGuardaModul,
  enviarConflicte,
  enviarNoTrobat,
  enviarValidacio,
  MODULS_OPERATIUS_APOYO,
  parsearIdPublic,
  parsearPaginacio,
} from './comu.js';

/**
 * Punt 55 (reformulat amb el client, 18/11/2026): proveïdors. De moment
 * només el nom. Es fan servir com a «proveïdor preferit» de l'article i com
 * a proveïdor de cada línia de comanda; el Panell Obrador hi filtra.
 *
 * Lectura: qualsevol mòdul que els mostri (catàleg, comandes, panells i el
 * propi manteniment). Escriptura: només el mòdul 'proveidors'.
 */
const GUARD_LECTURA = crearGuardaModul([...MODULS_OPERATIUS_APOYO, 'catalog', 'proveidors']);
const GUARD_ESCRIPTURA = crearGuardaModul('proveidors');

const MAX_NOM = 100;

interface FilaProveidor {
  id_seq: string;
  nom: string;
}

function aApi(fila: FilaProveidor): ProveidorApi {
  return { id: Number(fila.id_seq), nom: fila.nom };
}

/** `false` si el nom no és vàlid (buit, massa llarg o no és text). */
function llegirNom(valor: unknown): string | false {
  if (typeof valor !== 'string') return false;
  const nom = valor.trim();
  return nom !== '' && nom.length <= MAX_NOM ? nom : false;
}

function esNomRepetit(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505' &&
    (err as { constraint?: string }).constraint === 'idx_proveidor_nom'
  );
}

/**
 * id públic → uuid. `undefined` si no ve, `null` si ve a null (treure'l),
 * `false` si no és un id vàlid o el proveïdor no existeix.
 */
export async function resolverProveidorUuid(
  db: Pool | PoolClient,
  valor: unknown,
): Promise<string | null | undefined | false> {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) return false;
  const fila = await db.query<{ id: string }>('SELECT id FROM proveidor WHERE id_seq = $1', [
    valor,
  ]);
  return fila.rows[0]?.id ?? false;
}

export function registrarRutesProveidors(fastify: FastifyInstance): void {
  fastify.get('/proveidors', { preHandler: GUARD_LECTURA }, async (req) => {
    const { pagina, mida, offset } = parsearPaginacio(req.query as Record<string, unknown>);
    const total = await pool.query<{ count: string }>('SELECT count(*) FROM proveidor');
    const files = await pool.query<FilaProveidor>(
      'SELECT id_seq, nom FROM proveidor ORDER BY lower(nom) ASC, id_seq ASC LIMIT $1 OFFSET $2',
      [mida, offset],
    );
    return {
      dades: files.rows.map(aApi),
      paginacio: construirPaginacio(pagina, mida, Number(total.rows[0]?.count ?? 0)),
    };
  });

  fastify.post('/proveidors', { preHandler: GUARD_ESCRIPTURA }, async (req, reply) => {
    const nom = llegirNom((req.body as { nom?: unknown } | null)?.nom);
    if (nom === false) {
      return enviarValidacio(reply, 'El nom és obligatori', [
        { camp: 'nom', missatge: `és obligatori, com a màxim ${MAX_NOM} caràcters` },
      ]);
    }
    try {
      const inserit = await pool.query<FilaProveidor>(
        'INSERT INTO proveidor (nom) VALUES ($1) RETURNING id_seq, nom',
        [nom],
      );
      reply.code(201);
      return aApi(inserit.rows[0]!);
    } catch (err) {
      if (esNomRepetit(err))
        return enviarConflicte(reply, 'Ja existeix un proveïdor amb aquest nom');
      throw err;
    }
  });

  fastify.patch('/proveidors/:id', { preHandler: GUARD_ESCRIPTURA }, async (req, reply) => {
    const idPublic = parsearIdPublic((req.params as { id: string }).id);
    if (idPublic === null) return enviarNoTrobat(reply, 'Proveïdor no trobat');
    const nom = llegirNom((req.body as { nom?: unknown } | null)?.nom);
    if (nom === false) {
      return enviarValidacio(reply, 'El nom és obligatori', [
        { camp: 'nom', missatge: `és obligatori, com a màxim ${MAX_NOM} caràcters` },
      ]);
    }
    try {
      const resultat = await pool.query<FilaProveidor>(
        'UPDATE proveidor SET nom = $2 WHERE id_seq = $1 RETURNING id_seq, nom',
        [idPublic, nom],
      );
      if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Proveïdor no trobat');
      return aApi(resultat.rows[0]);
    } catch (err) {
      if (esNomRepetit(err))
        return enviarConflicte(reply, 'Ja existeix un proveïdor amb aquest nom');
      throw err;
    }
  });

  /**
   * Esborrat de veritat, però només si ningú no el fa servir: les FK de
   * `producte.proveidor_defecte_id` i `comanda_linia.proveidor_id` són
   * RESTRICT, i aquí es comprova abans per donar un missatge clar.
   */
  fastify.delete('/proveidors/:id', { preHandler: GUARD_ESCRIPTURA }, async (req, reply) => {
    const idPublic = parsearIdPublic((req.params as { id: string }).id);
    if (idPublic === null) return enviarNoTrobat(reply, 'Proveïdor no trobat');

    const us = await pool.query<{ id: string; articles: string; linies: string }>(
      `SELECT pv.id,
              (SELECT count(*) FROM producte p WHERE p.proveidor_defecte_id = pv.id) AS articles,
              (SELECT count(*) FROM comanda_linia cl
                WHERE cl.proveidor_id = pv.id) AS linies
       FROM proveidor pv WHERE pv.id_seq = $1`,
      [idPublic],
    );
    const fila = us.rows[0];
    if (!fila) return enviarNoTrobat(reply, 'Proveïdor no trobat');
    const articles = Number(fila.articles);
    const linies = Number(fila.linies);
    if (articles > 0 || linies > 0) {
      return enviarConflicte(
        reply,
        `No es pot esborrar: és el proveïdor preferit de ${articles} article(s) i el de ${linies} línia(es) de comanda`,
      );
    }
    try {
      await pool.query('DELETE FROM proveidor WHERE id = $1', [fila.id]);
    } catch (err) {
      // Carrera: algú l'ha assignat entre la comprovació i l'esborrat.
      if ((err as { code?: string }).code === '23503') {
        return enviarConflicte(reply, 'No es pot esborrar: ara mateix algú el fa servir');
      }
      throw err;
    }
    reply.code(204);
    return;
  });
}
