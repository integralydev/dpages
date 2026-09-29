import type { ClientApi } from '@dpages/shared';
import type { FastifyInstance } from 'fastify';
import { assignarCodiAutogenerat } from '../../../db/client-codi.js';
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
  resolverTarifaUuid,
  resolverTransportistaUuid,
} from './comu.js';

interface FilaClient {
  id_seq: string;
  codi: string | null;
  nom: string | null;
  nif: string | null;
  email: string | null;
  telefon: string | null;
  poblacio: string | null;
  actiu: boolean;
  tarifa_id_seq: string | null;
  tarifa_nom: string | null;
  transportista_id_seq: string | null;
  transportista_nom: string | null;
}

function aApi(fila: FilaClient): ClientApi {
  return {
    id: Number(fila.id_seq),
    codi: fila.codi,
    nom: fila.nom,
    nif: fila.nif,
    email: fila.email,
    telefon: fila.telefon,
    poblacio: fila.poblacio,
    tarifa:
      fila.tarifa_id_seq !== null && fila.tarifa_nom !== null
        ? { id: Number(fila.tarifa_id_seq), nom: fila.tarifa_nom }
        : null,
    transportistaDefecte:
      fila.transportista_id_seq !== null && fila.transportista_nom !== null
        ? { id: Number(fila.transportista_id_seq), nom: fila.transportista_nom }
        : null,
    actiu: fila.actiu,
  };
}

const SELECT_CLIENT = `
  SELECT cl.id_seq, cl.codi, cl.nom, cl.nif, cl.email, cl.telefon, cl.poblacio, cl.actiu,
         t.id_seq AS tarifa_id_seq, t.nom AS tarifa_nom,
         tr.id_seq AS transportista_id_seq, tr.nom AS transportista_nom
  FROM client cl
  LEFT JOIN tarifa t ON t.id = cl.tarifa_id
  LEFT JOIN transportista tr ON tr.id = cl.transportista_defecte_id
`;

export function registrarRutesClients(fastify: FastifyInstance): void {
  // Endpoint de referència (consumit des de OrderForm/office/packaging/
  // client-tariffs vía useClientTariffs — ver MODULS_OPERATIUS_APOYO a
  // comu.ts): lectura oberta a qualsevol mòdul operatiu, escriptura
  // restringida a "tarifes-clients" (pantalla pròpia d'aquest recurs).
  fastify.get(
    '/clients',
    { preHandler: crearGuardaModul(MODULS_OPERATIUS_APOYO) },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const { pagina, mida, offset } = parsearPaginacio(query);

      const condicions: string[] = [];
      const valors: unknown[] = [];

      if (typeof query.cerca === 'string' && query.cerca.trim() !== '') {
        condicions.push(
          `(cl.nom ILIKE $${valors.length + 1} OR cl.codi ILIKE $${valors.length + 1})`,
        );
        valors.push(`%${query.cerca.trim()}%`);
      }
      if (typeof query.tarifaId === 'string') {
        const tarifaIdPublic = parsearIdPublic(query.tarifaId);
        if (tarifaIdPublic === null) return enviarValidacio(reply, 'tarifaId ha de ser un enter');
        const tarifaUuid = await resolverTarifaUuid(pool, tarifaIdPublic);
        condicions.push(`cl.tarifa_id = $${valors.length + 1}`);
        valors.push(tarifaUuid ?? '00000000-0000-0000-0000-000000000000');
      }
      if (query.actiu === 'true' || query.actiu === 'false') {
        condicions.push(`cl.actiu = $${valors.length + 1}`);
        valors.push(query.actiu === 'true');
      }
      const where = condicions.length > 0 ? `WHERE ${condicions.join(' AND ')}` : '';

      const total = await pool.query<{ count: string }>(
        `SELECT count(*) FROM client cl ${where}`,
        valors,
      );
      const files = await pool.query<FilaClient>(
        `${SELECT_CLIENT} ${where} ORDER BY cl.nom ASC NULLS LAST, cl.id_seq ASC LIMIT $${valors.length + 1} OFFSET $${valors.length + 2}`,
        [...valors, mida, offset],
      );

      return {
        dades: files.rows.map(aApi),
        paginacio: construirPaginacio(pagina, mida, Number(total.rows[0]?.count ?? 0)),
      };
    },
  );

  /**
   * Alta manual (prototipo /pedidos/nuevo): los pedidos por WhatsApp/teléfono
   * no traen ningún cliente de WooCommerce que resolver — oficina lo carga a
   * mano. nom/poblacio son los campos mínimos confirmados por el prototipo;
   * email/telefon/nif no aparecen en ese modal pero van a hacer falta para
   * tener un dato de contacto en esos pedidos.
   *
   * `codi` NO se lee del cuerpo: se autogenera siempre, mismo mecanismo
   * que ya usa el sync de WooCommerce (`assignarCodiAutogenerat`) —
   * decisión de negocio confirmada, sin distinguir origen. Es de sólo
   * lectura para siempre, así que ni
   * `ClientCreacioApi` (packages/shared) ni este `Partial<{...}>` declaran
   * el campo — si llega en el body, se ignora en silencio (mismo criterio
   * que `firebaseUid`/`email` en `PATCH /usuaris/:id`).
   */
  fastify.post(
    '/clients',
    { preHandler: crearGuardaModul('tarifes-clients') },
    async (req, reply) => {
      const cos = req.body as Partial<{
        nom: string;
        poblacio: string;
        tarifaId: number;
        email: string;
        telefon: string;
        nif: string;
      }>;

      const detalls: { camp: string; missatge: string }[] = [];
      if (!cos.nom || cos.nom.trim() === '') {
        detalls.push({ camp: 'nom', missatge: 'és obligatori' });
      }
      if (!cos.poblacio || cos.poblacio.trim() === '') {
        detalls.push({ camp: 'poblacio', missatge: 'és obligatòria' });
      }
      if (detalls.length > 0) {
        return enviarValidacio(reply, 'Falten dades obligatòries', detalls);
      }

      let tarifaUuid: string | null = null;
      if (cos.tarifaId !== undefined) {
        tarifaUuid = await resolverTarifaUuid(pool, cos.tarifaId);
        if (tarifaUuid === null) {
          return enviarValidacio(reply, 'La tarifa indicada no existeix', [
            { camp: 'tarifaId', missatge: 'no existeix' },
          ]);
        }
      }

      const insertat = await pool.query<{ id: string; id_seq: string }>(
        `INSERT INTO client (nom, poblacio, tarifa_id, email, telefon, nif)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, id_seq`,
        [
          cos.nom!.trim(),
          cos.poblacio!.trim(),
          tarifaUuid,
          cos.email ?? null,
          cos.telefon ?? null,
          cos.nif ?? null,
        ],
      );

      // Defensa en profundidad (mismo criterio que categories.ts/tarifes.ts):
      // con id_seq único por fila, CLI+id_seq nunca debería colisionar de
      // verdad — pero si alguna vez pasara (idx_client_codi es un índice
      // único real), mejor un 409 claro que un 500 crudo.
      try {
        await assignarCodiAutogenerat(pool, insertat.rows[0]!.id, insertat.rows[0]!.id_seq);
      } catch (err) {
        if (esViolacioCodiUnic(err)) {
          return enviarConflicte(reply, 'Ja existeix un client amb aquest codi');
        }
        throw err;
      }

      const creat = await pool.query<FilaClient>(`${SELECT_CLIENT} WHERE cl.id_seq = $1`, [
        insertat.rows[0]!.id_seq,
      ]);
      reply.code(201);
      return aApi(creat.rows[0]!);
    },
  );

  fastify.patch(
    '/clients/:id',
    { preHandler: crearGuardaModul('tarifes-clients') },
    async (req, reply) => {
      const idPublic = parsearIdPublic((req.params as { id: string }).id);
      if (idPublic === null) return enviarNoTrobat(reply);

      // codi és immutable un cop assignat (autogenerat sempre) — no es
      // llegeix del cos encara que vingui, no hi ha camp per a ell acà
      // (mateix criteri que firebaseUid/email a PATCH /usuaris/:id).
      const cos = req.body as Partial<{
        nom: string | null;
        nif: string | null;
        email: string | null;
        telefon: string | null;
        poblacio: string | null;
        tarifaId: number | null;
        transportistaDefecteId: number | null;
        actiu: boolean;
      }>;

      let tarifaUuid: string | null | undefined;
      if (cos.tarifaId !== undefined) {
        if (cos.tarifaId === null) {
          tarifaUuid = null;
        } else {
          tarifaUuid = await resolverTarifaUuid(pool, cos.tarifaId);
          if (tarifaUuid === null) {
            return enviarValidacio(reply, 'La tarifa indicada no existeix', [
              { camp: 'tarifaId', missatge: 'no existeix' },
            ]);
          }
        }
      }

      let transportistaUuid: string | null | undefined;
      if (cos.transportistaDefecteId !== undefined) {
        if (cos.transportistaDefecteId === null) {
          transportistaUuid = null;
        } else {
          transportistaUuid = await resolverTransportistaUuid(pool, cos.transportistaDefecteId);
          if (transportistaUuid === null) {
            return enviarValidacio(reply, 'El transportista indicat no existeix', [
              { camp: 'transportistaDefecteId', missatge: 'no existeix' },
            ]);
          }
        }
      }

      try {
        const resultat = await pool.query<{ id: string }>(
          `UPDATE client SET
           nom = CASE WHEN $2 THEN $3 ELSE nom END,
           nif = CASE WHEN $4 THEN $5 ELSE nif END,
           email = CASE WHEN $6 THEN $7 ELSE email END,
           telefon = CASE WHEN $8 THEN $9 ELSE telefon END,
           poblacio = CASE WHEN $10 THEN $11 ELSE poblacio END,
           tarifa_id = CASE WHEN $12 THEN $13 ELSE tarifa_id END,
           transportista_defecte_id = CASE WHEN $14 THEN $15 ELSE transportista_defecte_id END,
           actiu = COALESCE($16, actiu)
         WHERE id_seq = $1
         RETURNING id`,
          [
            idPublic,
            cos.nom !== undefined,
            cos.nom ?? null,
            cos.nif !== undefined,
            cos.nif ?? null,
            cos.email !== undefined,
            cos.email ?? null,
            cos.telefon !== undefined,
            cos.telefon ?? null,
            cos.poblacio !== undefined,
            cos.poblacio ?? null,
            tarifaUuid !== undefined,
            tarifaUuid ?? null,
            transportistaUuid !== undefined,
            transportistaUuid ?? null,
            cos.actiu ?? null,
          ],
        );

        if (!resultat.rows[0]) return enviarNoTrobat(reply, 'Client no trobat');

        const actualitzat = await pool.query<FilaClient>(`${SELECT_CLIENT} WHERE cl.id_seq = $1`, [
          idPublic,
        ]);
        return aApi(actualitzat.rows[0]!);
      } catch (err) {
        if (esViolacioCodiUnic(err)) {
          return enviarConflicte(
            reply,
            cos.nif !== undefined
              ? `Ja existeix un client amb el NIF "${cos.nif}"`
              : `Ja existeix un client amb l'email "${cos.email}"`,
          );
        }
        throw err;
      }
    },
  );
}
