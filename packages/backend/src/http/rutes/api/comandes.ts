import type {
  ComandaDetallApi,
  ComandaLiniaApi,
  ComandaResumApi,
  IncidenciaComandaApi,
} from '@dpages/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../../../db/pool.js';
import {
  condicioDataFinsInclusiva,
  construirPaginacio,
  crearGuardaModul,
  enviarConflicte,
  enviarNoTrobat,
  enviarValidacio,
  esUnitatsValides,
  formatearDataApi,
  parsearIdPublic,
  parsearPaginacio,
  resolverClientUuid,
  resolverComandaUuid,
  resolverTarifaUuid,
  resolverTransportistaUuid,
} from './comu.js';

// Guard de módulo (B1): a diferencia de la mayoría de las rutas de negocio,
// "comandes" es el único rol operativo real que lo consume directo (Oficina
// lo tiene junto a panell-oficina) — no necesita la regla de "apoyo" de
// MODULS_OPERATIUS_APOYO (comu.ts), estricto alcanza para los 6 roles
// reales de producción.
const GUARD_COMANDES = crearGuardaModul('comandes');

// Investigación post-B1 (hallazgo de Michelle): Panell Oficina
// (office/[id]/page.tsx) lee GET /comandes/:id en modo estricto de sólo
// lectura, compartiendo la misma ruta que orders/[id]/page.tsx (gestión
// completa, con escritura). Contra los 6 roles reales de hoy esto no
// abre ningún hueco (Oficina ya tiene el módulo 'comandes' además de
// 'panell-oficina'), pero es una red de seguridad para roles futuros:
// un Administrador podría crear en vivo (RoleFormModal) un rol de
// "oficina, sólo lectura" con únicamente panell-oficina, y ese rol debe
// poder ver el detalle sin heredar permisos de escritura sobre pedidos.
// A propósito NO se usa MODULS_OPERATIUS_APOYO (comu.ts): la
// investigación confirmó que sólo panell-oficina consume GET /comandes
// en la práctica, ningún otro panell — una lista de 5 módulos sería de
// más.
const GUARD_COMANDES_LECTURA = crearGuardaModul(['comandes', 'panell-oficina']);

// Únics 5 valors admesos per comanda.estat (mateixa llista que el CHECK
// constraint de la taula, migracions 0003 i 0021).
const ESTATS_COMANDA_VALIDS = [
  'oberta',
  'en_proces',
  'tancada',
  'amb_incidencia',
  'cancellada',
] as const;

// Mateix criteri que CODIS_ORIGEN_ELEGIBLES al frontend (OrderForm.tsx):
// només els 3 canals manuals es poden triar a mà. "manual" és un valor
// històric. "woocommerce" queda BLOQUEJAT en els dos sentits (tasca 11,
// 01/10/2026, reverteix la decisió anterior que el feia triable): només el
// posa la sincronització automàtica, no es pot triar en crear una comanda
// a mà ni canviar-lo en una comanda que ja ve de WooCommerce.
const CODIS_ORIGEN_EDITABLES = ['whatsapp', 'telefon', 'correu'] as const;
const CODI_ORIGEN_WOOCOMMERCE = 'woocommerce';

interface FilaComandaResum {
  id_seq: string;
  num: string;
  origen: string;
  estat: string;
  client_id_seq: string | null;
  client_nom: string | null;
  client_poblacio: string | null;
  tarifa_id_seq: string | null;
  tarifa_nom: string | null;
  transportista_id_seq: string | null;
  transportista_nom: string | null;
  poblacio_desti: string | null;
  adreca_lliurament: string | null;
  // string, no Date: DATE (no TIMESTAMPTZ) — ver el comentario en db/pool.ts
  // sobre por qué se registra un parser propio para esta columna.
  data_comanda: string;
  data_produccio: Date | null;
  dates_produccio_linies: Date[];
  data_expedicio: Date | null;
  data_lliurament: Date | null;
  bultos: number | null;
  congelat_a: Date | null;
  obs_produccio: string | null;
  obs_lliurament: string | null;
  total_linies: string;
  total_kg: string;
  total_eur: string;
  total_incidencies: string;
  tipus_incidencia: string | null;
}

function aApiResum(fila: FilaComandaResum): ComandaResumApi {
  return {
    id: Number(fila.id_seq),
    num: fila.num,
    origen: fila.origen,
    estat: fila.estat,
    client:
      fila.client_id_seq !== null && fila.client_nom !== null
        ? { id: Number(fila.client_id_seq), nom: fila.client_nom, poblacio: fila.client_poblacio }
        : null,
    tarifa:
      fila.tarifa_id_seq !== null && fila.tarifa_nom !== null
        ? { id: Number(fila.tarifa_id_seq), nom: fila.tarifa_nom }
        : null,
    transportista:
      fila.transportista_id_seq !== null && fila.transportista_nom !== null
        ? { id: Number(fila.transportista_id_seq), nom: fila.transportista_nom }
        : null,
    poblacioDesti: fila.poblacio_desti,
    adrecaLliurament: fila.adreca_lliurament,
    dataComanda: formatearDataApi(fila.data_comanda)!,
    dataProduccio: formatearDataApi(fila.data_produccio),
    datesProduccioLinies: fila.dates_produccio_linies.map((d) => formatearDataApi(d)!),
    dataExpedicio: formatearDataApi(fila.data_expedicio),
    dataLliurament: formatearDataApi(fila.data_lliurament),
    bultos: fila.bultos,
    totalLinies: Number(fila.total_linies),
    totalKg: fila.total_kg,
    totalEur: fila.total_eur,
    congelada: fila.congelat_a !== null,
    totalIncidencies: Number(fila.total_incidencies),
    tipusIncidencia: fila.tipus_incidencia,
  };
}

// data_comanda (issue #16): YA NO es comanda.creat_en. Es una columna
// propia (DATE, migración 0019), dato de negocio EDITABLE que el usuario
// carga/corrige — distinta de creat_en, que sigue siendo el timestamp real
// e inalterable de auditoría (cuándo entró la fila a la base, nunca
// expuesto en la API).
// tipus_incidencia: sólo se completa cuando TODAS las incidencias de la
// comanda comparten el mismo tipus (min() de un conjunto de un solo valor
// distinto); si hay más de un tipo mezclado, queda null — "resumen liviano",
// el detalle completo por tipo está en GET /comandes/:id (incidencies[]).
const SELECT_COMANDA_RESUM = `
  SELECT c.id_seq, c.num, oc.codi AS origen, c.estat,
         cl.id_seq AS client_id_seq, cl.nom AS client_nom, cl.poblacio AS client_poblacio,
         t.id_seq AS tarifa_id_seq, t.nom AS tarifa_nom,
         tr.id_seq AS transportista_id_seq, tr.nom AS transportista_nom,
         c.poblacio_desti, c.adreca_lliurament, c.data_comanda, c.data_produccio,
         COALESCE(dp.dates, '{}') AS dates_produccio_linies, c.data_expedicio,
         c.data_lliurament, c.bultos, c.congelat_a, c.obs_produccio, c.obs_lliurament,
         COALESCE(agg.total_linies, 0) AS total_linies,
         COALESCE(agg.total_kg, 0)::numeric(14,3) AS total_kg,
         COALESCE(agg.total_eur, 0)::numeric(14,2) AS total_eur,
         COALESCE(inc.total_incidencies, 0) AS total_incidencies,
         inc.tipus_incidencia
  FROM comanda c
  JOIN origen_comanda oc ON oc.id = c.origen_id
  LEFT JOIN client cl ON cl.id = c.client_id
  LEFT JOIN tarifa t ON t.id = c.tarifa_id
  LEFT JOIN transportista tr ON tr.id = c.transportista_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS total_linies, SUM(pes_calculat_kg) AS total_kg,
           SUM(unitats_demanades * preu_unitari) AS total_eur
    FROM comanda_linia WHERE comanda_id = c.id AND NOT esborrat
  ) agg ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS total_incidencies,
           CASE WHEN count(DISTINCT tipus) = 1 THEN min(tipus) END AS tipus_incidencia
    FROM incidencia_comanda WHERE comanda_id = c.id
  ) inc ON true
  -- Fechas de producción DISTINTAS entre las líneas del pedido, ordenadas
  -- — ver ComandaResumApi.datesProduccioLinies.
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT data_produccio ORDER BY data_produccio) AS dates
    FROM comanda_linia
    WHERE comanda_id = c.id AND NOT esborrat AND data_produccio IS NOT NULL
  ) dp ON true
`;

interface FilaComandaLinia {
  id_seq: string;
  ordinal: number;
  producte_id_seq: string | null;
  producte_codi: string | null;
  producte_descripcio: string | null;
  categoria_nom: string | null;
  format: string | null;
  envasat: string | null;
  // NUMERIC(10,2) desde la migración 0016 (antes INTEGER): `pg` siempre
  // devuelve columnas NUMERIC como string, nunca number.
  unitats_demanades: string;
  kg_demanats: string;
  pes_editable: boolean;
  unitats_lliurades: string;
  kg_lliurats: string;
  confirmat_a: Date | null;
  preu_unitari: string;
  total_linia: string;
  data_produccio: Date | null;
  obs_produccio: string | null;
  esborrat: boolean;
}

function aApiLinia(fila: FilaComandaLinia): ComandaLiniaApi {
  return {
    id: Number(fila.id_seq),
    ordinal: fila.ordinal,
    producte:
      fila.producte_id_seq !== null && fila.producte_descripcio !== null
        ? {
            id: Number(fila.producte_id_seq),
            codi: fila.producte_codi,
            descripcio: fila.producte_descripcio,
          }
        : null,
    categoria: fila.categoria_nom,
    format: fila.format,
    envasat: fila.envasat,
    unitatsDemanades: fila.unitats_demanades,
    kgDemanats: fila.kg_demanats,
    kgEditable: fila.pes_editable,
    unitatsLliurades: fila.unitats_lliurades,
    kgLliurats: fila.kg_lliurats,
    confirmatA: formatearDataApi(fila.confirmat_a),
    preuUnitari: fila.preu_unitari,
    totalLinia: fila.total_linia,
    dataProduccio: formatearDataApi(fila.data_produccio),
    obsProduccio: fila.obs_produccio,
    esborrat: fila.esborrat,
  };
}

const SELECT_COMANDA_LINIA = `
  SELECT cl.id_seq, cl.ordinal, p.id_seq AS producte_id_seq, p.codi AS producte_codi,
         p.descripcio AS producte_descripcio, cat.nom AS categoria_nom, p.format, p.envasat,
         cl.unitats_demanades, cl.pes_calculat_kg AS kg_demanats,
         cl.pes_editable, cl.unitats_lliurades, cl.kg_lliurats, cl.confirmat_a, cl.preu_unitari,
         (cl.unitats_demanades * cl.preu_unitari)::numeric(14,2) AS total_linia,
         cl.data_produccio, cl.obs_produccio, cl.esborrat
  FROM comanda_linia cl
  LEFT JOIN producte p ON p.id = cl.producte_id
  LEFT JOIN categoria_producte cat ON cat.id = p.categoria_id
  WHERE cl.comanda_id = $1 AND NOT cl.esborrat
  ORDER BY cl.ordinal ASC
`;

interface FilaIncidenciaComanda {
  tipus: string;
  detall: string;
  creat_en: Date;
}

function aApiIncidencia(fila: FilaIncidenciaComanda): IncidenciaComandaApi {
  return { tipus: fila.tipus, detall: fila.detall, creatA: formatearDataApi(fila.creat_en)! };
}

const SELECT_COMANDA_INCIDENCIES = `
  SELECT tipus, detall, creat_en FROM incidencia_comanda
  WHERE comanda_id = $1
  ORDER BY creat_en ASC
`;

/** Detalle completo (cabecera + líneas + incidencias) por UUID interno — usado por GET/POST/PATCH para no repetir la misma consulta tres veces. */
async function carregarDetallPerUuid(comandaUuid: string): Promise<ComandaDetallApi> {
  const cap = await pool.query<FilaComandaResum>(`${SELECT_COMANDA_RESUM} WHERE c.id = $1`, [
    comandaUuid,
  ]);
  const linies = await pool.query<FilaComandaLinia>(SELECT_COMANDA_LINIA, [comandaUuid]);
  const incidencies = await pool.query<FilaIncidenciaComanda>(SELECT_COMANDA_INCIDENCIES, [
    comandaUuid,
  ]);
  const fila = cap.rows[0]!;
  const {
    totalLinies: _totalLinies,
    totalIncidencies: _totalInc,
    tipusIncidencia: _tipusInc,
    ...resum
  } = aApiResum(fila);
  return {
    ...resum,
    obsProduccio: fila.obs_produccio,
    obsLliurament: fila.obs_lliurament,
    congelatA: formatearDataApi(fila.congelat_a),
    linies: linies.rows.map(aApiLinia),
    incidencies: incidencies.rows.map(aApiIncidencia),
  };
}

/** 409 CONFLICTE si está congelada (contrato, sección 4.5) — se llama antes de cualquier UPDATE/DELETE. */
async function estaCongelada(dbPool: Pool, comandaUuid: string): Promise<boolean> {
  const res = await dbPool.query<{ congelat_a: Date | null }>(
    'SELECT congelat_a FROM comanda WHERE id = $1',
    [comandaUuid],
  );
  return res.rows[0]?.congelat_a !== null && res.rows[0]?.congelat_a !== undefined;
}

/**
 * Cascada de resolución de precio de línia (contrato,
 * `ComandaLiniaApi.preuUnitari`): 1) la tarifa indicada, si tiene precio
 * para este producto; 2) si no, el precio base del producto; 3) si tampoco
 * hay ninguno de los dos, "0.00" — `sensePreu` le indica al llamador que hay
 * que registrar una incidencia, nunca queda una línea con precio
 * silenciosamente en cero.
 *
 * La "tarifa indicada" (`tarifaId`) depende de quién llama, esta función no
 * decide eso:
 * - `POST /comandes`: el `tarifaId` explícito del body si vino, si no la
 *   del cliente (`client.tarifa_id`).
 * - `POST /comandes/:comandaId/linies`: SIEMPRE la del cliente, resuelta
 *   fresca.
 * - `comanda.tarifa_id` editado después vía `PATCH /comandes/:id` NO pasa
 *   nunca por acá — esa edición no recalcula líneas existentes, a propósito
 *   (fuera de alcance, ver docs/contrato-api.md).
 */
async function resolverPreuLinia(
  dbPool: Pool,
  tarifaId: string | null,
  producteUuid: string,
  preuVenda: string | null,
): Promise<{ preuUnitari: string; sensePreu: boolean }> {
  if (tarifaId !== null) {
    const tarifa = await dbPool.query<{ preu: string }>(
      'SELECT preu FROM tarifa_preu WHERE tarifa_id = $1 AND producte_id = $2',
      [tarifaId, producteUuid],
    );
    if (tarifa.rows[0]) return { preuUnitari: tarifa.rows[0].preu, sensePreu: false };
  }
  if (preuVenda !== null) return { preuUnitari: preuVenda, sensePreu: false };
  return { preuUnitari: '0.00', sensePreu: true };
}

/**
 * Recalcula `comanda.total` a partir de las líneas activas, con la MISMA
 * fórmula que ya usa `SELECT_COMANDA_RESUM.agg.total_eur`
 * (`SUM(unitats_demanades * preu_unitari) WHERE NOT esborrat`).
 *
 * IMPORTANTE, para quien lea esto después: ningún `GET` lee esta columna.
 * `ComandaResumApi.totalEur`/`ComandaDetallApi.totalEur` SIEMPRE se
 * calculan en vivo desde `comanda_linia` (ver `agg` en
 * `SELECT_COMANDA_RESUM`) — `comanda.total` es un campo espejo que sólo
 * escriben `POST /comandes` (al crear) y el sync de WooCommerce
 * (`transform/comandes.ts`), nunca se vuelve a leer por la API. Se
 * mantiene igual aquí por higiene de datos (que la columna no quede
 * desactualizada), no porque afecte ninguna respuesta visible. Ni
 * `DELETE /comandes/:comandaId/linies/:liniaId` recalcula esta columna —
 * gap preexistente, no se toca acá.
 */
async function recalcularTotalComanda(client: PoolClient, comandaUuid: string): Promise<void> {
  await client.query(
    `UPDATE comanda SET total = (
       SELECT COALESCE(SUM(unitats_demanades * preu_unitari), 0)::numeric(14,2)
       FROM comanda_linia WHERE comanda_id = $1 AND NOT esborrat
     )
     WHERE id = $1`,
    [comandaUuid],
  );
}

interface CapcaleraDatesComanda {
  /**
   * Issue #16 — opcional a propòsit: la regla nova (7) que la compara amb
   * dataLliurament només aplica a
   * `POST /comandes` i `PATCH /comandes/:id` (els dos únics llocs on
   * dataComanda es fixa o pot canviar). `POST .../linies` i
   * `PATCH .../linies/:liniaId` no toquen dataComanda ni dataLliurament de
   * capçalera, així que no cal que la passin — s'omet la clau i la regla 7
   * simplement no s'avalua (mateix criteri que "si falta una data, la regla
   * no bloqueja res").
   */
  dataComanda?: string | Date | null;
  dataProduccio: string | Date | null;
  dataExpedicio: string | Date | null;
  dataLliurament: string | Date | null;
}

interface LiniaPerValidarDates {
  /** Identifica la línia dins del `missatge` d'error — un índex del body en alta ("línia 2") o el número públic d'una línia ja existent ("línia núm. 981"). */
  etiqueta: string;
  dataProduccio: string | Date | null | undefined;
}

/**
 * Les 6 regles originals de coherència temporal entre les dates de
 * capçalera d'un pedido i les dates de producció de les seves línies
 * (documentades a `docs/contrato-api.md`, secció 4.5), més la regla 7
 * (issue #16) que compara dataComanda amb dataLliurament. Punt únic de
 * veritat: NO duplicar aquesta comparació als 4 llocs que la criden
 * (`POST /comandes`, `POST .../linies`, `PATCH .../linies/:liniaId`,
 * `PATCH /comandes/:id`).
 *
 * Cada regla només aplica si AMBDUES dates comparades tenen valor — si en
 * falta una, aquesta regla en concret no bloqueja res. "anterior"/
 * "posterior" és ESTRICTE: dates iguals estan permeses (no hi havia una
 * resolució explícita del client sobre aquest cas límit; es documenta a
 * `docs/contrato-api.md` perquè quedi com a criteri explícit, no un
 * misteri).
 *
 * Retorna la PRIMERA violació trobada, o `null` si tot és coherent — no
 * cal acumular-les totes, amb la primera ja n'hi ha prou per al 400.
 */
function validarCoherenciaDatesComanda(
  capcalera: CapcaleraDatesComanda,
  linies: LiniaPerValidarDates[],
): { camp: string; missatge: string } | null {
  // dataComanda ?? null normalitza el cas "no s'ha passat" (undefined) al
  // mateix "no hi ha valor" (null) que ja fan servir les altres 3 dates.
  const dcRaw = capcalera.dataComanda ?? null;
  const dc = dcRaw !== null ? new Date(dcRaw).getTime() : null;
  const dp = capcalera.dataProduccio !== null ? new Date(capcalera.dataProduccio).getTime() : null;
  const de = capcalera.dataExpedicio !== null ? new Date(capcalera.dataExpedicio).getTime() : null;
  const dl =
    capcalera.dataLliurament !== null ? new Date(capcalera.dataLliurament).getTime() : null;

  // Regla 7 (issue #16): dataComanda no pot ser posterior a dataLliurament.
  if (dc !== null && dl !== null && dc > dl) {
    return { camp: 'dataComanda', missatge: 'no pot ser posterior a dataLliurament' };
  }
  // Regla 1: dataLliurament no anterior a dataProduccio (capçalera).
  if (dp !== null && dl !== null && dl < dp) {
    return { camp: 'dataLliurament', missatge: 'no pot ser anterior a dataProduccio' };
  }
  // Regla 2: dataExpedicio no anterior a dataProduccio (capçalera).
  if (dp !== null && de !== null && de < dp) {
    return { camp: 'dataExpedicio', missatge: 'no pot ser anterior a dataProduccio' };
  }
  // Regla 3: dataExpedicio no posterior a dataLliurament.
  if (de !== null && dl !== null && de > dl) {
    return { camp: 'dataExpedicio', missatge: 'no pot ser posterior a dataLliurament' };
  }

  for (const linia of linies) {
    if (linia.dataProduccio === null || linia.dataProduccio === undefined) continue;
    const dLinia = new Date(linia.dataProduccio).getTime();
    // Regla 4: dataProduccio de línia no anterior a dataProduccio de capçalera.
    if (dp !== null && dLinia < dp) {
      return {
        camp: 'linies[].dataProduccio',
        missatge: `${linia.etiqueta}: dataProduccio no pot ser anterior a la dataProduccio de la comanda`,
      };
    }
    // Regla 5: dataProduccio de línia no posterior a dataLliurament.
    if (dl !== null && dLinia > dl) {
      return {
        camp: 'linies[].dataProduccio',
        missatge: `${linia.etiqueta}: dataProduccio no pot ser posterior a dataLliurament`,
      };
    }
    // Regla 6: dataProduccio de línia no posterior a dataExpedicio.
    if (de !== null && dLinia > de) {
      return {
        camp: 'linies[].dataProduccio',
        missatge: `${linia.etiqueta}: dataProduccio no pot ser posterior a dataExpedicio`,
      };
    }
  }

  return null;
}

async function resolverComandaOResponder(
  reply: FastifyReply,
  idParam: string,
): Promise<string | null> {
  const idPublic = parsearIdPublic(idParam);
  if (idPublic === null) {
    enviarNoTrobat(reply, 'Comanda no trobada');
    return null;
  }
  const uuid = await resolverComandaUuid(pool, idPublic);
  if (uuid === null) {
    enviarNoTrobat(reply, 'Comanda no trobada');
    return null;
  }
  return uuid;
}

export function registrarRutesComandes(fastify: FastifyInstance): void {
  fastify.get('/comandes', { preHandler: GUARD_COMANDES_LECTURA }, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const { pagina, mida, offset } = parsearPaginacio(query);

    const condicions: string[] = [];
    const valors: unknown[] = [];

    if (typeof query.estat === 'string' && query.estat !== '') {
      condicions.push(`c.estat = $${valors.length + 1}`);
      valors.push(query.estat);
    }
    if (typeof query.origen === 'string' && query.origen !== '') {
      condicions.push(`oc.codi = $${valors.length + 1}`);
      valors.push(query.origen);
    }
    if (typeof query.clientId === 'string') {
      const clientIdPublic = parsearIdPublic(query.clientId);
      if (clientIdPublic === null) return enviarValidacio(reply, 'clientId ha de ser un enter');
      const clientUuid = await resolverClientUuid(pool, clientIdPublic);
      condicions.push(`c.client_id = $${valors.length + 1}`);
      valors.push(clientUuid ?? '00000000-0000-0000-0000-000000000000');
    }
    // Issue #16: dataDes/dataFins filtran por dataComanda (docs/contrato-api.md
    // § 4.5) — desde la migración 0019 eso es c.data_comanda, ya NO
    // c.creat_en (que ahora divergen: data_comanda es editable por el
    // usuario, creat_en sigue siendo el timestamp real e inalterable de
    // cuándo se guardó la fila).
    if (typeof query.dataDes === 'string' && query.dataDes !== '') {
      condicions.push(`c.data_comanda >= $${valors.length + 1}`);
      valors.push(query.dataDes);
    }
    if (typeof query.dataFins === 'string' && query.dataFins !== '') {
      condicions.push(condicioDataFinsInclusiva('c.data_comanda', valors.length + 1));
      valors.push(query.dataFins);
    }
    // Filtra "el pedido tiene AL MENOS UNA línea cuya dataProduccio cae en
    // el rango" (caso de uso: planificación de obrador). Las dos
    // condiciones van en el MISMO EXISTS para que sea
    // una sola línea la que cumpla ambos extremos a la vez — dos EXISTS
    // separados matchearían igual si una línea cumple sólo "des" y otra
    // distinta cumple sólo "fins", sin que ninguna caiga realmente en el
    // rango pedido.
    const condicionsLiniaProduccio: string[] = [];
    if (typeof query.dataProduccioDes === 'string' && query.dataProduccioDes !== '') {
      condicionsLiniaProduccio.push(`cl2.data_produccio >= $${valors.length + 1}`);
      valors.push(query.dataProduccioDes);
    }
    if (typeof query.dataProduccioFins === 'string' && query.dataProduccioFins !== '') {
      condicionsLiniaProduccio.push(
        condicioDataFinsInclusiva('cl2.data_produccio', valors.length + 1),
      );
      valors.push(query.dataProduccioFins);
    }
    if (condicionsLiniaProduccio.length > 0) {
      condicions.push(
        `EXISTS (SELECT 1 FROM comanda_linia cl2 WHERE cl2.comanda_id = c.id ` +
          `AND NOT cl2.esborrat AND ${condicionsLiniaProduccio.join(' AND ')})`,
      );
    }
    if (typeof query.dataLliuramentDes === 'string' && query.dataLliuramentDes !== '') {
      condicions.push(`c.data_lliurament >= $${valors.length + 1}`);
      valors.push(query.dataLliuramentDes);
    }
    if (typeof query.dataLliuramentFins === 'string' && query.dataLliuramentFins !== '') {
      condicions.push(condicioDataFinsInclusiva('c.data_lliurament', valors.length + 1));
      valors.push(query.dataLliuramentFins);
    }
    // Issue #17 — `cerca` ya buscaba por `c.num`; se AMPLÍA (no se
    // reemplaza) para que también encuentre por nombre de
    // CLIENTE, reemplazando un filtro client-side que daba totales/
    // resultados inconsistentes al filtrar sólo sobre la página ya cargada.
    // Substring (ILIKE), NO exacto — mismo criterio que `cerca` en
    // clients.ts (buscar un pedido por parte del nombre de su cliente sí
    // tiene sentido de negocio, a diferencia de productes.ts/tarifes.ts,
    // regla 3.1). No toca `?clientId=` (filtro exacto, sin cambios).
    if (typeof query.cerca === 'string' && query.cerca.trim() !== '') {
      condicions.push(`(c.num ILIKE $${valors.length + 1} OR cl.nom ILIKE $${valors.length + 1})`);
      valors.push(`%${query.cerca.trim()}%`);
    }
    const where = condicions.length > 0 ? `WHERE ${condicions.join(' AND ')}` : '';

    // El count necesita el mismo JOIN a `client` que ya usa SELECT_COMANDA_RESUM
    // (más abajo) porque `where` ahora puede referenciar `cl.nom` — antes
    // bastaba con `origen_comanda` porque ninguna condición tocaba `client`.
    const total = await pool.query<{ count: string }>(
      `SELECT count(*) FROM comanda c
       JOIN origen_comanda oc ON oc.id = c.origen_id
       LEFT JOIN client cl ON cl.id = c.client_id
       ${where}`,
      valors,
    );
    const files = await pool.query<FilaComandaResum>(
      `${SELECT_COMANDA_RESUM} ${where} ORDER BY c.creat_en DESC, c.id_seq ASC LIMIT $${valors.length + 1} OFFSET $${valors.length + 2}`,
      [...valors, mida, offset],
    );

    return {
      dades: files.rows.map(aApiResum),
      paginacio: construirPaginacio(pagina, mida, Number(total.rows[0]?.count ?? 0)),
    };
  });

  fastify.get('/comandes/:id', { preHandler: GUARD_COMANDES_LECTURA }, async (req, reply) => {
    const comandaUuid = await resolverComandaOResponder(reply, (req.params as { id: string }).id);
    if (comandaUuid === null) return;
    return carregarDetallPerUuid(comandaUuid);
  });

  fastify.post('/comandes', { preHandler: GUARD_COMANDES }, async (req, reply) => {
    const cos = req.body as Partial<{
      origen: string;
      clientId: number;
      tarifaId: number;
      dataComanda: string;
      dataLliurament: string;
      transportistaId: number;
      obsLliurament: string;
      linies: {
        producteId: number;
        unitatsDemanades: number;
        kgDemanats?: string;
        dataProduccio?: string | null;
      }[];
    }>;

    // Issue #16 — dataComanda/dataLliurament de capçalera passen a ser
    // OBLIGATÒRIES, sense valor per defecte al
    // backend (el frontend precarrega HOY, però qui garanteix que arriba és
    // aquesta validació, no un default silenciós acá). Mateix estil que la
    // resta d'aquest bloc (origen/linies).
    //
    // Issue #21 — dataProduccio de línia deixa de ser obligatòria (revertia
    // una decisió de negoci de l'issue #16): ja no es valida acá.
    const detalls: { camp: string; missatge: string }[] = [];
    if (!cos.origen || cos.origen.trim() === '') {
      detalls.push({ camp: 'origen', missatge: 'és obligatori' });
    }
    if (!cos.dataComanda || cos.dataComanda.trim() === '') {
      detalls.push({ camp: 'dataComanda', missatge: 'és obligatori' });
    }
    if (!cos.dataLliurament || cos.dataLliurament.trim() === '') {
      detalls.push({ camp: 'dataLliurament', missatge: 'és obligatori' });
    }
    if (!cos.linies || cos.linies.length === 0) {
      detalls.push({ camp: 'linies', missatge: 'la comanda ha de tenir com a mínim una línia' });
    }
    if (detalls.length > 0) {
      return enviarValidacio(reply, 'Falten dades obligatòries', detalls);
    }

    // Al crear, la comanda encara no té dataProduccio/dataExpedicio de
    // capçalera (no són camps d'aquest body), així que de les 7 regles,
    // aquí només poden arribar a disparar-se les que depenen de
    // dataLliurament (regla 5 per a cada línia) o de dataComanda (regla 7,
    // issue #16 — dataComanda no pot ser posterior a dataLliurament; ambdues
    // sempre venen al body des que són obligatòries).
    const violacioCreacio = validarCoherenciaDatesComanda(
      {
        dataComanda: cos.dataComanda!,
        dataProduccio: null,
        dataExpedicio: null,
        dataLliurament: cos.dataLliurament!,
      },
      cos.linies!.map((l, i) => ({ etiqueta: `línia ${i + 1}`, dataProduccio: l.dataProduccio })),
    );
    if (violacioCreacio) {
      return enviarValidacio(reply, 'Les dates no són coherents', [violacioCreacio]);
    }

    // Tasca 11: una comanda creada a mà mai pot dir que ve de WooCommerce.
    if (cos.origen === CODI_ORIGEN_WOOCOMMERCE) {
      return enviarValidacio(reply, "L'origen WooCommerce no es pot triar a mà", [
        { camp: 'origen', missatge: 'woocommerce només el posa la sincronització automàtica' },
      ]);
    }

    // origen ja no és un enum fix (migració 0013): és el codi d'una fila
    // d'origen_comanda — es resol igual que clientId/transportistaId més
    // avall.
    const origen = await pool.query<{ id: string }>(
      'SELECT id FROM origen_comanda WHERE codi = $1',
      [cos.origen],
    );
    if (!origen.rows[0]) {
      return enviarValidacio(reply, "L'origen indicat no existeix", [
        { camp: 'origen', missatge: 'no existeix' },
      ]);
    }
    const origenUuid = origen.rows[0].id;

    let clientUuid: string | null = null;
    let clientTarifaId: string | null = null;
    if (cos.clientId !== undefined) {
      clientUuid = await resolverClientUuid(pool, cos.clientId);
      if (clientUuid === null) {
        return enviarValidacio(reply, 'El client indicat no existeix', [
          { camp: 'clientId', missatge: 'no existeix' },
        ]);
      }
      const clientFila = await pool.query<{ tarifa_id: string | null }>(
        'SELECT tarifa_id FROM client WHERE id = $1',
        [clientUuid],
      );
      clientTarifaId = clientFila.rows[0]?.tarifa_id ?? null;
    }
    // tarifaId explícito en el body de creación anula la del cliente SÓLO
    // para resolver el precio de estas líneas, y se guarda en
    // comanda.tarifa_id (columna ya existente, hasta ahora sólo editable
    // vía PATCH y sin efecto real en el precio — ver nota en
    // resolverPreuLinia). Si no viene, comportamiento idéntico al de
    // siempre: se usa clientTarifaId y comanda.tarifa_id queda NULL.
    let tarifaUuid: string | null = null;
    if (cos.tarifaId !== undefined) {
      tarifaUuid = await resolverTarifaUuid(pool, cos.tarifaId);
      if (tarifaUuid === null) {
        return enviarValidacio(reply, 'La tarifa indicada no existeix', [
          { camp: 'tarifaId', missatge: 'no existeix' },
        ]);
      }
    }
    const tarifaEfectivaId = tarifaUuid ?? clientTarifaId;
    let transportistaUuid: string | null = null;
    if (cos.transportistaId !== undefined) {
      transportistaUuid = await resolverTransportistaUuid(pool, cos.transportistaId);
      if (transportistaUuid === null) {
        return enviarValidacio(reply, 'El transportista indicat no existeix', [
          { camp: 'transportistaId', missatge: 'no existeix' },
        ]);
      }
    }

    // Resolver y validar TODAS las líneas antes de escribir nada.
    const liniesResoltes: {
      producteUuid: string;
      producteIdPublic: number;
      unitats: number;
      preuUnitari: string;
      sensePreu: boolean;
      pesFitxaKg: string | null;
      pesCalculatKg: string;
      pesEditable: boolean;
      dataProduccio: string | null;
    }[] = [];

    for (let i = 0; i < cos.linies!.length; i++) {
      const linia = cos.linies![i]!;
      const camp = `linies[${i}]`;

      // unitats_demanades pasó de INTEGER a NUMERIC(10,2): admite
      // decimales (entregas/pedidos parciales de pieza), hasta 2 decimales.
      if (!esUnitatsValides(linia.unitatsDemanades)) {
        return enviarValidacio(reply, 'Les unitats demanades no poden ser zero', [
          {
            camp: `${camp}.unitatsDemanades`,
            missatge: 'ha de ser més gran que zero, com a màxim 2 decimals',
          },
        ]);
      }

      const producte = await pool.query<{
        id: string;
        pes_kg: string | null;
        preu_venda: string | null;
      }>('SELECT id, pes_kg, preu_venda FROM producte WHERE id_seq = $1', [linia.producteId]);
      if (!producte.rows[0]) {
        return enviarValidacio(reply, 'Un dels productes indicats no existeix', [
          { camp: `${camp}.producteId`, missatge: 'no existeix' },
        ]);
      }
      const { id: producteUuid, pes_kg: pesFitxaKg, preu_venda: preuVenda } = producte.rows[0];

      let pesCalculatKg: string;
      let pesEditable: boolean;
      if (pesFitxaKg !== null) {
        pesCalculatKg = (linia.unitatsDemanades * Number(pesFitxaKg)).toFixed(3);
        pesEditable = false;
      } else {
        const kgDemanats = linia.kgDemanats !== undefined ? Number(linia.kgDemanats) : NaN;
        if (!Number.isFinite(kgDemanats) || kgDemanats <= 0) {
          return enviarValidacio(reply, 'Els kg demanats no poden ser zero', [
            {
              camp: `${camp}.kgDemanats`,
              missatge: 'ha de ser més gran que zero (article a mida)',
            },
          ]);
        }
        pesCalculatKg = kgDemanats.toFixed(3);
        pesEditable = true;
      }

      const { preuUnitari, sensePreu } = await resolverPreuLinia(
        pool,
        tarifaEfectivaId,
        producteUuid,
        preuVenda,
      );

      liniesResoltes.push({
        producteUuid,
        producteIdPublic: linia.producteId,
        unitats: linia.unitatsDemanades,
        preuUnitari,
        sensePreu,
        pesFitxaKg,
        pesCalculatKg,
        pesEditable,
        // Issue #21 — dataProduccio deixa de ser obligatòria: normalitzada a
        // null (mateix criteri que cos.obsLliurament ?? null, més avall) en
        // comptes de deixar passar `undefined` cru al paràmetre de l'INSERT.
        dataProduccio: linia.dataProduccio ?? null,
      });
    }

    const client = await pool.connect();
    let comandaUuid: string;
    try {
      await client.query('BEGIN');

      const totalEur = liniesResoltes
        .reduce((acc, l) => acc + l.unitats * Number(l.preuUnitari), 0)
        .toFixed(2);

      const comanda = await client.query<{ id: string }>(
        `INSERT INTO comanda (origen_id, estat, client_id, tarifa_id, poblacio_desti, total,
                               data_lliurament, transportista_id, obs_lliurament, data_comanda)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          origenUuid,
          // Decisión de negocio confirmada — una línea sin precio resuelto
          // NUNCA queda silenciosa (se registra igual en
          // incidencia_comanda, más abajo), pero ya no fuerza el pedido a
          // amb_incidencia: nace "oberta" siempre, el precio pendiente se
          // completa después sin bloquear el flujo normal.
          'oberta',
          clientUuid,
          tarifaUuid,
          totalEur,
          cos.dataLliurament!,
          transportistaUuid,
          cos.obsLliurament ?? null,
          cos.dataComanda!,
        ],
      );
      comandaUuid = comanda.rows[0]!.id;

      for (let i = 0; i < liniesResoltes.length; i++) {
        const l = liniesResoltes[i]!;
        await client.query(
          `INSERT INTO comanda_linia (comanda_id, ordinal, producte_id, unitats_demanades,
                                       preu_unitari, pes_fitxa_kg, pes_calculat_kg, pes_editable,
                                       data_produccio)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            comandaUuid,
            i,
            l.producteUuid,
            l.unitats,
            l.preuUnitari,
            l.pesFitxaKg,
            l.pesCalculatKg,
            l.pesEditable,
            l.dataProduccio,
          ],
        );
        if (l.sensePreu) {
          await client.query(
            `INSERT INTO incidencia_comanda (comanda_id, tipus, detall) VALUES ($1, 'sense_preu', $2)`,
            [
              comandaUuid,
              `Línia ${i + 1}: el producte ${l.producteIdPublic} no té preu resolt (sense tarifa amb preu ni preu base) — preuUnitari es va deixar en 0.00.`,
            ],
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    reply.code(201);
    return carregarDetallPerUuid(comandaUuid);
  });

  fastify.patch('/comandes/:id', { preHandler: GUARD_COMANDES }, async (req, reply) => {
    const comandaUuid = await resolverComandaOResponder(reply, (req.params as { id: string }).id);
    if (comandaUuid === null) return;

    if (await estaCongelada(pool, comandaUuid)) {
      return enviarConflicte(reply, 'La comanda està congelada i ja no admet canvis');
    }

    const cos = req.body as Partial<{
      clientId: number | null;
      tarifaId: number | null;
      transportistaId: number | null;
      dataComanda: string;
      dataProduccio: string | null;
      dataExpedicio: string | null;
      dataLliurament: string | null;
      bultos: number | null;
      obsProduccio: string | null;
      obsLliurament: string | null;
      poblacioDesti: string | null;
      adrecaLliurament: string | null;
      estat: string;
      detall: string;
      origen: string;
    }>;

    // Issue #16 — dataComanda SÍ es editable después de creada (a diferencia
    // de producteId/categoriaId en otros endpoints): regla de negocio
    // confirmada. Pero a diferencia de dataProduccio/dataExpedicio/
    // dataLliurament (nullable en la base, se pueden "vaciar" con `null`),
    // dataComanda es NOT NULL — no tiene sentido vaciarla, se rechaza en vez
    // de dejar que el INSERT/UPDATE falle con un error crudo de Postgres.
    if (cos.dataComanda !== undefined && (!cos.dataComanda || cos.dataComanda.trim() === '')) {
      return enviarValidacio(reply, 'dataComanda no pot estar buida', [
        { camp: 'dataComanda', missatge: 'no pot estar buida' },
      ]);
    }

    if (cos.estat !== undefined) {
      if (!ESTATS_COMANDA_VALIDS.includes(cos.estat as (typeof ESTATS_COMANDA_VALIDS)[number])) {
        return enviarValidacio(reply, 'El estat indicat no és vàlid', [
          { camp: 'estat', missatge: `ha de ser un de: ${ESTATS_COMANDA_VALIDS.join(', ')}` },
        ]);
      }
      // Decisión de negocio: transiciones libres entre los 5 estados, sin
      // máquina de estados. Única excepción: pasar a
      // amb_incidencia manualmente exige un motivo (detall), porque a
      // diferencia de las incidencias automáticas (sense_preu, etc.) acá no
      // hay ningún dato del sistema del que derivarlo.
      if (cos.estat === 'amb_incidencia' && (!cos.detall || cos.detall.trim() === '')) {
        return enviarValidacio(reply, 'El detall és obligatori per marcar amb_incidencia', [
          { camp: 'detall', missatge: 'és obligatori quan estat és amb_incidencia' },
        ]);
      }
    }

    // Reassignació d'origen: cap a qualsevol dels 3 canals triables a mà
    // (CODIS_ORIGEN_EDITABLES). Tasca 11: si la comanda ve de WooCommerce,
    // el seu origen ja no es pot canviar (reenviar el mateix valor és un
    // no-op, no un error). Es resol igual que a POST /comandes (codi →
    // UUID), amb el mateix criteri de "no existeix".
    let origenUuid: string | undefined;
    if (cos.origen !== undefined) {
      const origenActual = await pool.query<{ codi: string }>(
        `SELECT oc.codi FROM comanda c JOIN origen_comanda oc ON oc.id = c.origen_id WHERE c.id = $1`,
        [comandaUuid],
      );
      const esWoocommerce = origenActual.rows[0]?.codi === CODI_ORIGEN_WOOCOMMERCE;
      if (esWoocommerce && cos.origen === CODI_ORIGEN_WOOCOMMERCE) {
        cos.origen = undefined;
      } else if (esWoocommerce) {
        return enviarValidacio(reply, "L'origen d'una comanda de WooCommerce no es pot canviar", [
          { camp: 'origen', missatge: 'la comanda ve de WooCommerce' },
        ]);
      }
    }
    if (cos.origen !== undefined) {
      if (!CODIS_ORIGEN_EDITABLES.includes(cos.origen as (typeof CODIS_ORIGEN_EDITABLES)[number])) {
        return enviarValidacio(reply, "L'origen indicat no es pot triar a mà", [
          {
            camp: 'origen',
            missatge: `ha de ser un de: ${CODIS_ORIGEN_EDITABLES.join(', ')}`,
          },
        ]);
      }
      const origenFila = await pool.query<{ id: string }>(
        'SELECT id FROM origen_comanda WHERE codi = $1',
        [cos.origen],
      );
      if (!origenFila.rows[0]) {
        return enviarValidacio(reply, "L'origen indicat no existeix", [
          { camp: 'origen', missatge: 'no existeix' },
        ]);
      }
      origenUuid = origenFila.rows[0].id;
    }

    // El cas delicat: si aquest PATCH canvia alguna de les 3 dates de
    // capçalera, cal calcular l'estat RESULTANT (valor nou si ha vingut,
    // si no el que ja hi havia guardat) i validar-lo no només contra les
    // altres dates de capçalera (regles 1/2/3), sinó també contra TOTES les
    // línies actives del pedido (regles 4/5/6) — encara que cap d'elles
    // s'estigui tocant en aquest request. Un canvi de data de capçalera pot
    // invalidar una línia de la qual ningú s'està ocupant ara mateix.
    //
    // Issue #16 — dataComanda entra al mateix càlcul de "resultant" per la
    // regla 7 (dataComanda no pot ser posterior
    // a dataLliurament): si el PATCH només canvia UNA de les dues (per
    // exemple, només dataComanda), cal comparar-la contra el valor ACTUAL a
    // la base de l'altra — mai contra null ni assumir que la regla no
    // aplica. Per això aquest bloc ara també es dispara quan només ve
    // dataComanda al body (abans només mirava dataProduccio/dataExpedicio/
    // dataLliurament).
    if (
      cos.dataProduccio !== undefined ||
      cos.dataExpedicio !== undefined ||
      cos.dataLliurament !== undefined ||
      cos.dataComanda !== undefined
    ) {
      const actual = await pool.query<{
        data_comanda: string;
        data_produccio: Date | null;
        data_expedicio: Date | null;
        data_lliurament: Date | null;
      }>(
        'SELECT data_comanda, data_produccio, data_expedicio, data_lliurament FROM comanda WHERE id = $1',
        [comandaUuid],
      );
      const filaActual = actual.rows[0]!;
      const dataComandaResultant =
        cos.dataComanda !== undefined ? cos.dataComanda : filaActual.data_comanda;
      const dataProduccioResultant =
        cos.dataProduccio !== undefined ? cos.dataProduccio : filaActual.data_produccio;
      const dataExpedicioResultant =
        cos.dataExpedicio !== undefined ? cos.dataExpedicio : filaActual.data_expedicio;
      const dataLliuramentResultant =
        cos.dataLliurament !== undefined ? cos.dataLliurament : filaActual.data_lliurament;

      const liniesExistents = await pool.query<{ id_seq: string; data_produccio: Date | null }>(
        `SELECT id_seq, data_produccio FROM comanda_linia WHERE comanda_id = $1 AND NOT esborrat`,
        [comandaUuid],
      );

      const violacio = validarCoherenciaDatesComanda(
        {
          dataComanda: dataComandaResultant,
          dataProduccio: dataProduccioResultant,
          dataExpedicio: dataExpedicioResultant,
          dataLliurament: dataLliuramentResultant,
        },
        liniesExistents.rows.map((l) => ({
          etiqueta: `línia núm. ${l.id_seq}`,
          dataProduccio: l.data_produccio,
        })),
      );
      if (violacio) {
        return enviarValidacio(reply, 'Les dates no són coherents', [violacio]);
      }
    }

    let clientUuid: string | null | undefined;
    if (cos.clientId !== undefined) {
      clientUuid = cos.clientId === null ? null : await resolverClientUuid(pool, cos.clientId);
      if (cos.clientId !== null && clientUuid === null) {
        return enviarValidacio(reply, 'El client indicat no existeix', [
          { camp: 'clientId', missatge: 'no existeix' },
        ]);
      }
    }
    let tarifaUuid: string | null | undefined;
    if (cos.tarifaId !== undefined) {
      tarifaUuid = cos.tarifaId === null ? null : await resolverTarifaUuid(pool, cos.tarifaId);
      if (cos.tarifaId !== null && tarifaUuid === null) {
        return enviarValidacio(reply, 'La tarifa indicada no existeix', [
          { camp: 'tarifaId', missatge: 'no existeix' },
        ]);
      }
    }
    let transportistaUuid: string | null | undefined;
    if (cos.transportistaId !== undefined) {
      transportistaUuid =
        cos.transportistaId === null
          ? null
          : await resolverTransportistaUuid(pool, cos.transportistaId);
      if (cos.transportistaId !== null && transportistaUuid === null) {
        return enviarValidacio(reply, 'El transportista indicat no existeix', [
          { camp: 'transportistaId', missatge: 'no existeix' },
        ]);
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE comanda SET
           client_id = CASE WHEN $2 THEN $3 ELSE client_id END,
           tarifa_id = CASE WHEN $4 THEN $5 ELSE tarifa_id END,
           transportista_id = CASE WHEN $6 THEN $7 ELSE transportista_id END,
           data_produccio = CASE WHEN $8 THEN $9 ELSE data_produccio END,
           data_expedicio = CASE WHEN $10 THEN $11 ELSE data_expedicio END,
           data_lliurament = CASE WHEN $12 THEN $13 ELSE data_lliurament END,
           bultos = CASE WHEN $14 THEN $15 ELSE bultos END,
           obs_produccio = CASE WHEN $16 THEN $17 ELSE obs_produccio END,
           obs_lliurament = CASE WHEN $18 THEN $19 ELSE obs_lliurament END,
           poblacio_desti = CASE WHEN $20 THEN $21 ELSE poblacio_desti END,
           adreca_lliurament = CASE WHEN $22 THEN $23 ELSE adreca_lliurament END,
           estat = CASE WHEN $24 THEN $25 ELSE estat END,
           data_comanda = CASE WHEN $26 THEN $27 ELSE data_comanda END,
           origen_id = CASE WHEN $28 THEN $29 ELSE origen_id END
         WHERE id = $1`,
        [
          comandaUuid,
          clientUuid !== undefined,
          clientUuid ?? null,
          tarifaUuid !== undefined,
          tarifaUuid ?? null,
          transportistaUuid !== undefined,
          transportistaUuid ?? null,
          cos.dataProduccio !== undefined,
          cos.dataProduccio ?? null,
          cos.dataExpedicio !== undefined,
          cos.dataExpedicio ?? null,
          cos.dataLliurament !== undefined,
          cos.dataLliurament ?? null,
          cos.bultos !== undefined,
          cos.bultos ?? null,
          cos.obsProduccio !== undefined,
          cos.obsProduccio ?? null,
          cos.obsLliurament !== undefined,
          cos.obsLliurament ?? null,
          cos.poblacioDesti !== undefined,
          cos.poblacioDesti ?? null,
          cos.adrecaLliurament !== undefined,
          cos.adrecaLliurament ?? null,
          cos.estat !== undefined,
          cos.estat ?? null,
          cos.dataComanda !== undefined,
          cos.dataComanda ?? null,
          origenUuid !== undefined,
          origenUuid ?? null,
        ],
      );

      // A diferencia de las incidencias automáticas (sense_preu,
      // article_no_resolt, etc.), ésta la dispara un usuario de oficina a
      // mano, sin que el sistema haya detectado nada por sí solo. Mismo
      // array/tabla (incidencia_comanda), tipus distinto para diferenciarla.
      if (cos.estat === 'amb_incidencia') {
        await client.query(
          `INSERT INTO incidencia_comanda (comanda_id, tipus, detall) VALUES ($1, 'manual', $2)`,
          [comandaUuid, cos.detall],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return carregarDetallPerUuid(comandaUuid);
  });

  /**
   * Agregar una línea a un pedido YA creado. Hasta ahora sólo se podían
   * cargar líneas embebidas en `POST /comandes` (alta completa) — la única
   * forma de corregir un pedido existente era borrarlo entero y recargarlo
   * de cero, perdiendo el número de pedido original.
   *
   * Precio: MISMA cascada que `POST /comandes` (`resolverPreuLinia`), sin
   * duplicar la lógica. La tarifa que se usa es la del CLIENTE asignado a
   * la comanda (resuelta fresca acá) — OJO: `comanda.tarifa_id` puede tener
   * un valor real (fijado al crear el pedido, o editado después vía
   * `PATCH /comandes/:id`), pero esta ruta NUNCA lo consulta, siempre usa
   * `client.tarifa_id`. No es un descuido, es a propósito.
   *
   * El body acepta `dataProduccio` para la línea nueva. Si viene, se valida
   * contra las fechas de cabecera YA GUARDADAS del pedido (reglas 4/5/6 de
   * `validarCoherenciaDatesComanda`).
   *
   * Issue #21 — dataProduccio deja de ser obligatoria acá (revierte la
   * decisión de issue #16, que la había igualado a `POST /comandes`).
   */
  fastify.post(
    '/comandes/:comandaId/linies',
    { preHandler: GUARD_COMANDES },
    async (req, reply) => {
      const comandaUuid = await resolverComandaOResponder(
        reply,
        (req.params as { comandaId: string }).comandaId,
      );
      if (comandaUuid === null) return;

      if (await estaCongelada(pool, comandaUuid)) {
        return enviarConflicte(reply, 'La comanda està congelada i ja no admet canvis');
      }

      const cos = req.body as Partial<{
        producteId: number;
        unitatsDemanades: number;
        kgDemanats: string;
        dataProduccio: string | null;
      }>;

      if (cos.producteId === undefined) {
        return enviarValidacio(reply, 'producteId és obligatori', [
          { camp: 'producteId', missatge: 'és obligatori' },
        ]);
      }
      // Ver nota equivalente en POST /comandes.
      if (!esUnitatsValides(cos.unitatsDemanades)) {
        return enviarValidacio(reply, 'Les unitats demanades no poden ser zero', [
          {
            camp: 'unitatsDemanades',
            missatge: 'ha de ser més gran que zero, com a màxim 2 decimals',
          },
        ]);
      }

      const producte = await pool.query<{
        id: string;
        pes_kg: string | null;
        preu_venda: string | null;
      }>('SELECT id, pes_kg, preu_venda FROM producte WHERE id_seq = $1', [cos.producteId]);
      if (!producte.rows[0]) {
        return enviarValidacio(reply, 'El producte indicat no existeix', [
          { camp: 'producteId', missatge: 'no existeix' },
        ]);
      }
      const { id: producteUuid, pes_kg: pesFitxaKg, preu_venda: preuVenda } = producte.rows[0];

      let pesCalculatKg: string;
      let pesEditable: boolean;
      if (pesFitxaKg !== null) {
        pesCalculatKg = (cos.unitatsDemanades * Number(pesFitxaKg)).toFixed(3);
        pesEditable = false;
      } else {
        const kgDemanats = cos.kgDemanats !== undefined ? Number(cos.kgDemanats) : NaN;
        if (!Number.isFinite(kgDemanats) || kgDemanats <= 0) {
          return enviarValidacio(reply, 'Els kg demanats no poden ser zero', [
            { camp: 'kgDemanats', missatge: 'ha de ser més gran que zero (article a mida)' },
          ]);
        }
        pesCalculatKg = kgDemanats.toFixed(3);
        pesEditable = true;
      }

      // Validar la dataProduccio de la línia nova contra les dates de
      // capçalera JA GUARDADES d'aquest pedido, abans d'inserir res.
      // Issue #21 — dataProduccio ja no és obligatòria: si no ve
      // (undefined/null), validarCoherenciaDatesComanda la salta sola (ja
      // tolera aquest cas, ver comu de les 6 regles).
      {
        const capcalera = await pool.query<{
          data_produccio: Date | null;
          data_expedicio: Date | null;
          data_lliurament: Date | null;
        }>('SELECT data_produccio, data_expedicio, data_lliurament FROM comanda WHERE id = $1', [
          comandaUuid,
        ]);
        const fila = capcalera.rows[0]!;
        const violacio = validarCoherenciaDatesComanda(
          {
            dataProduccio: fila.data_produccio,
            dataExpedicio: fila.data_expedicio,
            dataLliurament: fila.data_lliurament,
          },
          [{ etiqueta: 'línia nova', dataProduccio: cos.dataProduccio }],
        );
        if (violacio) {
          return enviarValidacio(reply, 'Les dates no són coherents', [violacio]);
        }
      }

      const clientTarifaFila = await pool.query<{ tarifa_id: string | null }>(
        `SELECT cl.tarifa_id FROM comanda c LEFT JOIN client cl ON cl.id = c.client_id WHERE c.id = $1`,
        [comandaUuid],
      );
      const clientTarifaId = clientTarifaFila.rows[0]?.tarifa_id ?? null;

      const { preuUnitari, sensePreu } = await resolverPreuLinia(
        pool,
        clientTarifaId,
        producteUuid,
        preuVenda,
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const ordinalFila = await client.query<{ seguent: number }>(
          `SELECT COALESCE(max(ordinal), -1) + 1 AS seguent FROM comanda_linia WHERE comanda_id = $1`,
          [comandaUuid],
        );
        const ordinal = ordinalFila.rows[0]!.seguent;

        await client.query(
          `INSERT INTO comanda_linia (comanda_id, ordinal, producte_id, unitats_demanades,
                                     preu_unitari, pes_fitxa_kg, pes_calculat_kg, pes_editable,
                                     data_produccio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            comandaUuid,
            ordinal,
            producteUuid,
            cos.unitatsDemanades,
            preuUnitari,
            pesFitxaKg,
            pesCalculatKg,
            pesEditable,
            // Issue #21 — normalizada a null, mismo patrón que la línea 776
            // (cos.obsLliurament ?? null): dataProduccio ya no es obligatoria,
            // pero el parámetro no debe recibir `undefined` crudo.
            cos.dataProduccio ?? null,
          ],
        );

        // Decisión de negocio confirmada — mismo criterio que POST
        // /comandes: una línea sin precio resuelto nunca queda
        // silenciosa (se registra igual en incidencia_comanda), pero ya no
        // fuerza el pedido a amb_incidencia — se queda en el estat que ya
        // tenía (oberta, en_proces, tancada...), el precio pendiente se
        // completa después sin bloquear el flujo normal.
        if (sensePreu) {
          await client.query(
            `INSERT INTO incidencia_comanda (comanda_id, tipus, detall) VALUES ($1, 'sense_preu', $2)`,
            [
              comandaUuid,
              `Línia afegida (producte ${cos.producteId}): no té preu resolt (sense tarifa amb preu ni preu base) — preuUnitari es va deixar en 0.00.`,
            ],
          );
        }

        await recalcularTotalComanda(client, comandaUuid);

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      reply.code(201);
      return carregarDetallPerUuid(comandaUuid);
    },
  );

  /**
   * Editar una línea existente (unitats/kg/dataProduccio/obsProduccio).
   * NUNCA re-resuelve `preuUnitari` — sólo recalcula `totalLinia`, y eso ya
   * es automático: `SELECT_COMANDA_LINIA` calcula `totalLinia` en vivo
   * (`unitats_demanades * preu_unitari`), no es una columna guardada.
   * Mientras esta ruta no toque `preu_unitari` (nunca lo hace), cualquier
   * lectura posterior ya sale bien sola.
   *
   * Si `dataProduccio` viene en el body, se valida contra las fechas de
   * cabecera YA GUARDADAS del pedido (reglas 4/5/6 de
   * `validarCoherenciaDatesComanda`) antes de escribir nada.
   */
  fastify.patch(
    '/comandes/:comandaId/linies/:liniaId',
    { preHandler: GUARD_COMANDES },
    async (req, reply) => {
      const params = req.params as { comandaId: string; liniaId: string };
      const comandaUuid = await resolverComandaOResponder(reply, params.comandaId);
      if (comandaUuid === null) return;

      if (await estaCongelada(pool, comandaUuid)) {
        return enviarConflicte(reply, 'La comanda està congelada i ja no admet canvis');
      }

      const liniaIdPublic = parsearIdPublic(params.liniaId);
      if (liniaIdPublic === null) return enviarNoTrobat(reply, 'Línia no trobada');

      const cos = req.body as Partial<{
        unitatsDemanades: number;
        kgDemanats: string;
        dataProduccio: string | null;
        obsProduccio: string | null;
      }>;

      // Ver nota equivalente en POST /comandes.
      if (cos.unitatsDemanades !== undefined && !esUnitatsValides(cos.unitatsDemanades)) {
        return enviarValidacio(reply, 'Les unitats demanades no poden ser zero', [
          {
            camp: 'unitatsDemanades',
            missatge: 'ha de ser més gran que zero, com a màxim 2 decimals',
          },
        ]);
      }
      if (cos.kgDemanats !== undefined) {
        const kgNum = Number(cos.kgDemanats);
        if (!Number.isFinite(kgNum) || kgNum <= 0) {
          return enviarValidacio(reply, 'Els kg demanats no poden ser zero', [
            { camp: 'kgDemanats', missatge: 'ha de ser més gran que zero' },
          ]);
        }
      }

      const liniaActual = await pool.query<{
        pes_editable: boolean;
        pes_fitxa_kg: string | null;
      }>(
        `SELECT pes_editable, pes_fitxa_kg FROM comanda_linia WHERE id_seq = $1 AND comanda_id = $2`,
        [liniaIdPublic, comandaUuid],
      );
      if (!liniaActual.rows[0]) return enviarNoTrobat(reply, 'Línia no trobada');
      const { pes_editable: pesEditable, pes_fitxa_kg: pesFitxaKg } = liniaActual.rows[0];

      if (cos.kgDemanats !== undefined && !pesEditable) {
        return enviarValidacio(reply, "El pes d'aquest article no és editable (té fitxa)", [
          { camp: 'kgDemanats', missatge: 'no editable — es calcula des de unitatsDemanades' },
        ]);
      }

      // Si cambian las unidades de un artículo CON fitxa, el peso se
      // recalcula solo (mismo criterio que POST /comandes) — kgDemanats no
      // se acepta en ese caso (ya rechazado arriba). Para un artículo "a
      // medida", el peso es lo que venga en kgDemanats, sin relación con
      // unitatsDemanades.
      let pesCalculatKgNou: string | undefined;
      if (cos.unitatsDemanades !== undefined && pesFitxaKg !== null) {
        pesCalculatKgNou = (cos.unitatsDemanades * Number(pesFitxaKg)).toFixed(3);
      } else if (cos.kgDemanats !== undefined) {
        pesCalculatKgNou = Number(cos.kgDemanats).toFixed(3);
      }

      // Si aquest PATCH canvia dataProduccio de la línia, validar-la contra
      // les dates de capçalera JA GUARDADES d'aquest pedido, abans
      // d'escriure res. Si dataProduccio NO ve al body, no hi ha res nou a
      // validar (ni la línia ni la capçalera van a canviar de valor per això).
      if (cos.dataProduccio !== undefined) {
        const capcalera = await pool.query<{
          data_produccio: Date | null;
          data_expedicio: Date | null;
          data_lliurament: Date | null;
        }>('SELECT data_produccio, data_expedicio, data_lliurament FROM comanda WHERE id = $1', [
          comandaUuid,
        ]);
        const fila = capcalera.rows[0]!;
        const violacio = validarCoherenciaDatesComanda(
          {
            dataProduccio: fila.data_produccio,
            dataExpedicio: fila.data_expedicio,
            dataLliurament: fila.data_lliurament,
          },
          [{ etiqueta: `línia ${liniaIdPublic}`, dataProduccio: cos.dataProduccio }],
        );
        if (violacio) {
          return enviarValidacio(reply, 'Les dates no són coherents', [violacio]);
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const resultat = await client.query<{ id: string }>(
          `UPDATE comanda_linia SET
           unitats_demanades = CASE WHEN $3 THEN $4 ELSE unitats_demanades END,
           pes_calculat_kg = CASE WHEN $5 THEN $6 ELSE pes_calculat_kg END,
           data_produccio = CASE WHEN $7 THEN $8 ELSE data_produccio END,
           obs_produccio = CASE WHEN $9 THEN $10 ELSE obs_produccio END
         WHERE id_seq = $1 AND comanda_id = $2
         RETURNING id`,
          [
            liniaIdPublic,
            comandaUuid,
            cos.unitatsDemanades !== undefined,
            cos.unitatsDemanades ?? null,
            pesCalculatKgNou !== undefined,
            pesCalculatKgNou ?? null,
            cos.dataProduccio !== undefined,
            cos.dataProduccio ?? null,
            cos.obsProduccio !== undefined,
            cos.obsProduccio ?? null,
          ],
        );
        if (!resultat.rows[0]) {
          await client.query('ROLLBACK');
          return enviarNoTrobat(reply, 'Línia no trobada');
        }

        await recalcularTotalComanda(client, comandaUuid);

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return carregarDetallPerUuid(comandaUuid);
    },
  );

  fastify.delete(
    '/comandes/:comandaId/linies/:liniaId',
    { preHandler: GUARD_COMANDES },
    async (req, reply) => {
      const params = req.params as { comandaId: string; liniaId: string };
      const comandaUuid = await resolverComandaOResponder(reply, params.comandaId);
      if (comandaUuid === null) return;

      if (await estaCongelada(pool, comandaUuid)) {
        return enviarConflicte(reply, 'La comanda està congelada i ja no admet canvis');
      }

      const liniaIdPublic = parsearIdPublic(params.liniaId);
      if (liniaIdPublic === null) return enviarNoTrobat(reply, 'Línia no trobada');

      const resultat = await pool.query(
        `UPDATE comanda_linia SET esborrat = true
       WHERE id_seq = $1 AND comanda_id = $2 RETURNING id`,
        [liniaIdPublic, comandaUuid],
      );
      if (resultat.rowCount === 0) return enviarNoTrobat(reply, 'Línia no trobada');

      reply.code(204);
    },
  );
}
