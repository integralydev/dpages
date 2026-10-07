import type {
  FilaPanellEmpaquetatApi,
  FilaPanellObradorAcumulatApi,
  FilaPanellObradorApi,
  FilaPanellOficinaApi,
  PanellProduccioFilaApi,
} from '@dpages/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../../../db/pool.js';
import {
  condicioDataFinsInclusiva,
  construirPaginacio,
  crearGuardaModul,
  enviarValidacio,
  formatearDataApi,
  parsearIdPublic,
  parsearPaginacio,
  resolverCategoriaUuid,
  resolverClientUuid,
  resolverTarifaUuid,
  resolverTransportistaUuid,
} from './comu.js';

async function resolverFiltreEntitat(
  reply: FastifyReply,
  valor: unknown,
  camp: string,
  resolver: (idSeq: number) => Promise<string | null>,
): Promise<string | undefined | null> {
  if (typeof valor !== 'string') return undefined;
  const idPublic = parsearIdPublic(valor);
  if (idPublic === null) {
    enviarValidacio(reply, `${camp} ha de ser un enter`);
    return null;
  }
  const uuid = await resolver(idPublic);
  return uuid ?? '00000000-0000-0000-0000-000000000000';
}

/**
 * Igual que `resolverFiltreEntitat`, però el paràmetre es pot repetir
 * (`?transportistaId=1&transportistaId=4`, tasca 22, 01/10/2026): retorna
 * els UUID de tots els ids. Un id que no existeix es resol al UUID buit
 * (mateix criteri: no coincideix amb res, no és un error). `undefined` =
 * sense filtre; `null` = resposta 400 ja enviada.
 */
async function resolverFiltreEntitats(
  reply: FastifyReply,
  valor: unknown,
  camp: string,
  resolver: (idSeq: number) => Promise<string | null>,
): Promise<string[] | undefined | null> {
  const valors = (Array.isArray(valor) ? valor : [valor]).filter(
    (item): item is string => typeof item === 'string',
  );
  if (valors.length === 0) return undefined;
  const uuids: string[] = [];
  for (const item of valors) {
    const uuid = await resolverFiltreEntitat(reply, item, camp, resolver);
    if (uuid === null) return null;
    if (uuid !== undefined) uuids.push(uuid);
  }
  return uuids;
}

/**
 * `?producte=` repetible (petició del client, 29/09/2026): `?producte=A&
 * producte=B` = línies de A o de B. Fastify ja lliura un array quan la clau
 * es repeteix; un sol valor funciona igual que sempre. Coincidència EXACTA
 * per descripció, case-insensitive (regla 3.1 transversal), mai substring.
 * Afegeix la condició a `condicions`/`valors` si hi ha cap producte.
 */
function afegirFiltreProductes(valor: unknown, condicions: string[], valors: unknown[]): void {
  const productes = (Array.isArray(valor) ? valor : [valor])
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim().toLowerCase());
  if (productes.length > 0) {
    condicions.push(`LOWER(p.descripcio) = ANY($${valors.length + 1}::text[])`);
    valors.push(productes);
  }
}

type AgrupacioRendiment = 'KG' | 'MAGRE' | 'PAQ';
const AGRUPACIONS_RENDIMENT: readonly AgrupacioRendiment[] = ['KG', 'MAGRE', 'PAQ'];

function esAgrupacioRendimentValida(valor: unknown): valor is AgrupacioRendiment {
  return typeof valor === 'string' && AGRUPACIONS_RENDIMENT.includes(valor as AgrupacioRendiment);
}

/**
 * Rendimiento fijo por cerdo, confirmado por el cliente: de 1 cerdo salen
 * 12Kg de jamón, 6Kg de recortes, y 7Kg de paletillas — de media. Valores
 * fijos, NO calculados desde `rendiments_porcs` (no hay artículos de
 * catálogo individuales para "jamón"/"recortes"/"paletillas" con esos
 * rendimientos cargados) — pendiente de exponer como configuración si
 * cambian en el futuro.
 *
 * ADVERTENCIA — NO reconectar esto a `rendiments_porcs` (PERNIL/RETALLS
 * 1RA+2NA/ESPATLLA) bajo ningún concepto: ya se intentó, asumiendo que el
 * desajuste contra `totalKgMagro` era un bug, y el cliente confirmó
 * explícitamente que NO lo es. Estas 3 tasas son una decisión de negocio
 * fija e independiente, sin relación con `rendiments_porcs` (esa tabla es
 * para el cálculo de Rendiment/Diferència de las FILAS KG/PAQ de la tabla
 * principal — un concepto distinto). Ejemplo real: con 1 cerdo, Total Kg
 * Magre = 25.000 (12+6+7), NO 30.000.
 */
const KG_JAMON_PER_CERDO = 12;
const KG_RECORTES_PER_CERDO = 6;
const KG_PALETILLAS_PER_CERDO = 7;

/**
 * Condicions de GET /panells/obrador, compartides amb l'acció massiva
 * POST /panells/obrador/marcar-fets (treball.ts, tasca 26): així "marcar
 * totes com a fetes" afecta exactament les línies que es veuen amb els
 * mateixos filtres, mai d'altres. Les condicions fan servir els àlies `cl`
 * (comanda_linia), `c` (comanda) i `p` (producte). `null` = resposta 400
 * ja enviada.
 */
export async function construirFiltresObrador(
  reply: FastifyReply,
  query: Record<string, unknown>,
): Promise<{ condicions: string[]; valors: unknown[] } | null> {
  // Fora: comandes cancel·lades (ver /panells/oficina) i esborranys
  // (tasca 33: l'esborrany no compta a Obrador ni Empaquetat).
  const condicions: string[] = ['NOT cl.esborrat', `c.estat NOT IN ('cancellada', 'esborrany')`];
  const valors: unknown[] = [];

  // dataProduccio filtra por la fecha de la LÍNEA (cl.data_produccio), no
  // la de la cabecera del pedido — desde que Obrador dejó de ser agregado
  // por producto (contrato, sección 4.7), es la línea la que tiene fecha
  // de producción propia; la de comanda es otro campo (sección 4.5).
  if (typeof query.dataProduccioDes === 'string' && query.dataProduccioDes !== '') {
    condicions.push(`cl.data_produccio >= $${valors.length + 1}`);
    valors.push(query.dataProduccioDes);
  }
  if (typeof query.dataProduccioFins === 'string' && query.dataProduccioFins !== '') {
    condicions.push(condicioDataFinsInclusiva('cl.data_produccio', valors.length + 1));
    valors.push(query.dataProduccioFins);
  }
  const categoriaUuid = await resolverFiltreEntitat(reply, query.categoriaId, 'categoriaId', (id) =>
    resolverCategoriaUuid(pool, id),
  );
  if (categoriaUuid === null) return null;
  if (categoriaUuid !== undefined) {
    condicions.push(`p.categoria_id = $${valors.length + 1}`);
    valors.push(categoriaUuid);
  }
  if (query.tipus === 'simple' || query.tipus === 'variable') {
    condicions.push(`p.tipus = $${valors.length + 1}`);
    valors.push(query.tipus);
  }
  afegirFiltreProductes(query.producte, condicions, valors);
  // Tasca 29: les línies d'un sol producte (desplegar una fila de la vista
  // acumulada), per id públic.
  if (query.producteId !== undefined && query.producteId !== '') {
    const producteId =
      typeof query.producteId === 'string' ? parsearIdPublic(query.producteId) : null;
    if (producteId === null) {
      enviarValidacio(reply, 'producteId ha de ser un enter');
      return null;
    }
    condicions.push(`p.id_seq = $${valors.length + 1}`);
    valors.push(producteId);
  }
  if (typeof query.format === 'string' && query.format.trim() !== '') {
    condicions.push(`p.format = $${valors.length + 1}`);
    valors.push(query.format.trim());
  }
  if (typeof query.envasat === 'string' && query.envasat.trim() !== '') {
    condicions.push(`p.envasat = $${valors.length + 1}`);
    valors.push(query.envasat.trim());
  }
  // Tasca 25 (01/10/2026): client de la comanda.
  const clientUuid = await resolverFiltreEntitat(reply, query.clientId, 'clientId', (id) =>
    resolverClientUuid(pool, id),
  );
  if (clientUuid === null) return null;
  if (clientUuid !== undefined) {
    condicions.push(`c.client_id = $${valors.length + 1}`);
    valors.push(clientUuid);
  }
  // Tasca 28: una o més agrupacions de producció (OR), repetible igual que
  // ?producte=. Coincidència exacta.
  const agrupacions = (
    Array.isArray(query.agrupacioProduccio) ? query.agrupacioProduccio : [query.agrupacioProduccio]
  ).filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (agrupacions.length > 0) {
    condicions.push(`p.agrupacio_produccio = ANY($${valors.length + 1}::text[])`);
    valors.push(agrupacions.map((item) => item.trim()));
  }
  // Tasca 31: amb / sense observacions de producció DE LA LÍNIA (el panell
  // mostra dades de línia; les de capçalera de la comanda no compten).
  const ambObs = `COALESCE(TRIM(cl.obs_produccio), '') <> ''`;
  if (query.observacions === 'si') condicions.push(ambObs);
  else if (query.observacions === 'no') condicions.push(`NOT ${ambObs}`);
  else if (query.observacions !== undefined && query.observacions !== '') {
    enviarValidacio(reply, 'observacions ha de ser si o no', [
      { camp: 'observacions', missatge: 'ha de ser si o no' },
    ]);
    return null;
  }
  // Tasca 26: línies pendents (no marcades com a fetes) o ja fetes.
  if (query.treball === 'pendents') condicions.push('cl.treballat_a IS NULL');
  else if (query.treball === 'fets') condicions.push('cl.treballat_a IS NOT NULL');
  else if (query.treball !== undefined && query.treball !== '') {
    enviarValidacio(reply, 'treball ha de ser pendents o fets', [
      { camp: 'treball', missatge: 'ha de ser pendents o fets' },
    ]);
    return null;
  }
  return { condicions, valors };
}

export function registrarRutesPanells(fastify: FastifyInstance): void {
  // ── 4.6 · Panell Oficina ─────────────────────────────────────────────
  fastify.get(
    '/panells/oficina',
    { preHandler: crearGuardaModul('panell-oficina') },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const { pagina, mida, offset } = parsearPaginacio(query);

      const condicions: string[] = [];
      const valors: unknown[] = [];

      if (typeof query.dataExpedicioDes === 'string' && query.dataExpedicioDes !== '') {
        condicions.push(`c.data_expedicio >= $${valors.length + 1}`);
        valors.push(query.dataExpedicioDes);
      }
      if (typeof query.dataExpedicioFins === 'string' && query.dataExpedicioFins !== '') {
        condicions.push(condicioDataFinsInclusiva('c.data_expedicio', valors.length + 1));
        valors.push(query.dataExpedicioFins);
      }
      // Mismo criterio que dataExpedicioDes/Fins de arriba, sobre las otras
      // dos fechas de cabecera del pedido. Issue #16: dataComanda ya
      // NO es c.creat_en — es c.data_comanda (columna propia, editable,
      // migración 0019); creat_en sigue siendo sólo el timestamp de auditoría.
      if (typeof query.dataComandaDes === 'string' && query.dataComandaDes !== '') {
        condicions.push(`c.data_comanda >= $${valors.length + 1}`);
        valors.push(query.dataComandaDes);
      }
      if (typeof query.dataComandaFins === 'string' && query.dataComandaFins !== '') {
        condicions.push(condicioDataFinsInclusiva('c.data_comanda', valors.length + 1));
        valors.push(query.dataComandaFins);
      }
      if (typeof query.dataLliuramentDes === 'string' && query.dataLliuramentDes !== '') {
        condicions.push(`c.data_lliurament >= $${valors.length + 1}`);
        valors.push(query.dataLliuramentDes);
      }
      if (typeof query.dataLliuramentFins === 'string' && query.dataLliuramentFins !== '') {
        condicions.push(condicioDataFinsInclusiva('c.data_lliurament', valors.length + 1));
        valors.push(query.dataLliuramentFins);
      }
      // Els pedidos 'cancellada' no compten a cap panell (petició d'Ari,
      // 29/09/2026). Única excepció: aquí, si es filtra explícitament per
      // aquest estat — mai amb "Tots" (sense `estat`).
      if (typeof query.estat === 'string' && query.estat !== '') {
        condicions.push(`c.estat = $${valors.length + 1}`);
        valors.push(query.estat);
      } else {
        condicions.push(`c.estat <> 'cancellada'`);
      }
      const transportistaUuid = await resolverFiltreEntitat(
        reply,
        query.transportistaId,
        'transportistaId',
        (id) => resolverTransportistaUuid(pool, id),
      );
      if (transportistaUuid === null) return;
      if (transportistaUuid !== undefined) {
        condicions.push(`c.transportista_id = $${valors.length + 1}`);
        valors.push(transportistaUuid);
      }
      const clientUuid = await resolverFiltreEntitat(reply, query.clientId, 'clientId', (id) =>
        resolverClientUuid(pool, id),
      );
      if (clientUuid === null) return;
      if (clientUuid !== undefined) {
        condicions.push(`c.client_id = $${valors.length + 1}`);
        valors.push(clientUuid);
      }
      // Mismo patrón que transportistaId/clientId de arriba.
      const tarifaUuid = await resolverFiltreEntitat(reply, query.tarifaId, 'tarifaId', (id) =>
        resolverTarifaUuid(pool, id),
      );
      if (tarifaUuid === null) return;
      if (tarifaUuid !== undefined) {
        condicions.push(`c.tarifa_id = $${valors.length + 1}`);
        valors.push(tarifaUuid);
      }
      // Coincidencia EXACTA, case-insensitive — regla 3.1 transversal (mismo
      // criterio que ?producte= en /panells/obrador).
      if (typeof query.poblacioDesti === 'string' && query.poblacioDesti.trim() !== '') {
        condicions.push(`LOWER(c.poblacio_desti) = LOWER($${valors.length + 1})`);
        valors.push(query.poblacioDesti.trim());
      }
      const where = condicions.length > 0 ? `WHERE ${condicions.join(' AND ')}` : '';

      const base = `
      FROM comanda c
      LEFT JOIN client cl ON cl.id = c.client_id
      LEFT JOIN tarifa t ON t.id = c.tarifa_id
      LEFT JOIN transportista tr ON tr.id = c.transportista_id
      LEFT JOIN LATERAL (
        SELECT count(*) AS linies, SUM(pes_calculat_kg) AS total_kg,
               SUM(unitats_demanades * preu_unitari) AS total_eur
        FROM comanda_linia WHERE comanda_id = c.id AND NOT esborrat
      ) agg ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS total_incidencies,
               CASE WHEN count(DISTINCT tipus) = 1 THEN min(tipus) END AS tipus_incidencia
        FROM incidencia_comanda WHERE comanda_id = c.id
      ) inc ON true
      ${where}
    `;

      const totals = await pool.query<{
        comandes: string;
        linies: string;
        total_kg: string;
        total_eur: string;
      }>(
        `SELECT count(*) AS comandes, COALESCE(SUM(agg.linies), 0) AS linies,
              COALESCE(SUM(agg.total_kg), 0)::numeric(14,3) AS total_kg,
              COALESCE(SUM(agg.total_eur), 0)::numeric(14,2) AS total_eur
       ${base}`,
        valors,
      );

      const files = await pool.query<{
        id_seq: string;
        num: string;
        client_nom: string | null;
        poblacio_desti: string | null;
        tarifa_nom: string | null;
        transportista_nom: string | null;
        estat: string;
        // string, no Date: DATE (no TIMESTAMPTZ) — ver el comentario en
        // db/pool.ts sobre el parser propio para esta columna.
        data_comanda: string;
        data_expedicio: Date | null;
        data_lliurament: Date | null;
        bultos: number | null;
        linies: string;
        total_kg: string;
        total_eur: string;
        te_obs_produccio: boolean;
        obs_lliurament: string | null;
        total_incidencies: string;
        tipus_incidencia: string | null;
      }>(
        `SELECT c.id_seq, c.num, cl.nom AS client_nom, c.poblacio_desti, t.nom AS tarifa_nom,
              tr.nom AS transportista_nom, c.estat, c.data_comanda, c.data_expedicio,
              c.data_lliurament, c.bultos, COALESCE(agg.linies, 0) AS linies,
              COALESCE(agg.total_kg, 0)::numeric(14,3) AS total_kg,
              COALESCE(agg.total_eur, 0)::numeric(14,2) AS total_eur,
              (
                (c.obs_produccio IS NOT NULL AND c.obs_produccio <> '')
                OR EXISTS (
                  SELECT 1 FROM comanda_linia cl2
                  WHERE cl2.comanda_id = c.id AND NOT cl2.esborrat
                    AND cl2.obs_produccio IS NOT NULL AND cl2.obs_produccio <> ''
                )
              ) AS te_obs_produccio,
              c.obs_lliurament,
              COALESCE(inc.total_incidencies, 0) AS total_incidencies, inc.tipus_incidencia
       ${base}
       ORDER BY c.data_expedicio ASC NULLS LAST, c.creat_en ASC
       LIMIT $${valors.length + 1} OFFSET $${valors.length + 2}`,
        [...valors, mida, offset],
      );

      const dades: FilaPanellOficinaApi[] = files.rows.map((f) => ({
        comandaId: Number(f.id_seq),
        num: f.num,
        client: f.client_nom,
        poblacioDesti: f.poblacio_desti,
        tarifa: f.tarifa_nom,
        transportista: f.transportista_nom,
        estat: f.estat,
        dataComanda: formatearDataApi(f.data_comanda)!,
        dataExpedicio: formatearDataApi(f.data_expedicio),
        dataLliurament: formatearDataApi(f.data_lliurament),
        bultos: f.bultos,
        linies: Number(f.linies),
        totalKg: f.total_kg,
        totalEur: f.total_eur,
        obsProduccio: f.te_obs_produccio,
        obsLliurament: f.obs_lliurament,
        totalIncidencies: Number(f.total_incidencies),
        tipusIncidencia: f.tipus_incidencia,
      }));

      return {
        totals: {
          comandes: Number(totals.rows[0]?.comandes ?? 0),
          linies: Number(totals.rows[0]?.linies ?? 0),
          totalKg: totals.rows[0]?.total_kg ?? '0.000',
          totalEur: totals.rows[0]?.total_eur ?? '0.00',
        },
        dades,
        paginacio: construirPaginacio(pagina, mida, Number(totals.rows[0]?.comandes ?? 0)),
      };
    },
  );

  // ── 4.7 · Panell Obrador (líneas de pedido individuales, no agregado) ──
  fastify.get(
    '/panells/obrador',
    { preHandler: crearGuardaModul('panell-obrador') },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const { pagina, mida, offset } = parsearPaginacio(query);

      const filtres = await construirFiltresObrador(reply, query);
      if (filtres === null) return;
      const { condicions, valors } = filtres;
      const where = `WHERE ${condicions.join(' AND ')}`;

      // INNER JOIN a producte: una línia sin artículo resuelto (producte_id
      // nulo — ver migración 0005) no tiene nada que mostrar acá y queda
      // fuera.
      const base = `
      FROM comanda_linia cl
      JOIN comanda c ON c.id = cl.comanda_id
      JOIN producte p ON p.id = cl.producte_id
      LEFT JOIN categoria_producte cat ON cat.id = p.categoria_id
      LEFT JOIN client cli ON cli.id = c.client_id
      LEFT JOIN usuari tu ON tu.id = cl.treballat_per
      ${where}
    `;

      const totals = await pool.query<{
        linies: string;
        total_unitats: string;
        total_kg: string;
        linies_fetes: string;
      }>(
        // unitats_demanades ahora es NUMERIC(10,2) (antes INTEGER): el total
        // agregado gana el mismo cast explícito que totalKg (mismo criterio,
        // mismo riesgo de precisión que evitar sumar en JS).
        `SELECT count(*) AS linies,
              COALESCE(SUM(cl.unitats_demanades), 0)::numeric(10,2) AS total_unitats,
              COALESCE(SUM(cl.pes_calculat_kg), 0)::numeric(14,3) AS total_kg,
              count(*) FILTER (WHERE cl.treballat_a IS NOT NULL) AS linies_fetes
       ${base}`,
        valors,
      );

      const files = await pool.query<{
        linia_id_seq: string;
        comanda_id_seq: string;
        producte_id_seq: string;
        producte_codi: string | null;
        producte_descripcio: string;
        categoria_nom: string | null;
        agrupacio_produccio: string | null;
        format: string | null;
        envasat: string | null;
        client_nom: string | null;
        data_produccio: Date | null;
        unitats: string;
        kg: string;
        obs_produccio: string | null;
        treballat_a: Date | null;
        treballat_per_id_seq: string | null;
        treballat_per_nom: string | null;
      }>(
        `SELECT cl.id_seq AS linia_id_seq, c.id_seq AS comanda_id_seq,
              p.id_seq AS producte_id_seq, p.codi AS producte_codi, p.descripcio AS producte_descripcio,
              cat.nom AS categoria_nom, p.agrupacio_produccio, p.format, p.envasat, cli.nom AS client_nom,
              cl.data_produccio, cl.unitats_demanades AS unitats, cl.pes_calculat_kg AS kg,
              cl.obs_produccio, cl.treballat_a,
              tu.id_seq AS treballat_per_id_seq, tu.nom AS treballat_per_nom
       ${base}
       -- Pendents primer, per defecte (no és un parametre opcional): amb
       -- paginacio real de 20/50 files, una pagina podria mostrar nomes
       -- linies ja treballades si les pendents queien en una altra pagina.
       -- (cl.treballat_a IS NOT NULL) val false per a
       -- pendents i true per a treballades — ASC posa false (pendents)
       -- primer. La resta de l'ordre (data_produccio, num, ordinal) es
       -- exactament el mateix que ja hi havia, sense tocar.
       ORDER BY (cl.treballat_a IS NOT NULL) ASC,
                cl.data_produccio ASC NULLS LAST, c.num ASC, cl.ordinal ASC
       LIMIT $${valors.length + 1} OFFSET $${valors.length + 2}`,
        [...valors, mida, offset],
      );

      const dades: FilaPanellObradorApi[] = files.rows.map((f) => ({
        liniaId: Number(f.linia_id_seq),
        comandaId: Number(f.comanda_id_seq),
        producte: {
          id: Number(f.producte_id_seq),
          codi: f.producte_codi,
          descripcio: f.producte_descripcio,
        },
        agrupacioProduccio: f.agrupacio_produccio,
        categoria: f.categoria_nom,
        format: f.format,
        envasat: f.envasat,
        client: f.client_nom,
        dataProduccio: formatearDataApi(f.data_produccio),
        unitats: f.unitats,
        kg: f.kg,
        obsProduccio: f.obs_produccio,
        // Ver PATCH /comandes/:comandaId/linies/:liniaId/treball.
        treballatA: formatearDataApi(f.treballat_a),
        treballatPer:
          f.treballat_per_id_seq !== null && f.treballat_per_nom !== null
            ? { id: Number(f.treballat_per_id_seq), nom: f.treballat_per_nom }
            : null,
      }));

      return {
        totals: {
          linies: Number(totals.rows[0]?.linies ?? 0),
          // String desde ahora (ver nota en el SELECT de arriba).
          totalUnitats: totals.rows[0]?.total_unitats ?? '0.00',
          totalKg: totals.rows[0]?.total_kg ?? '0.000',
          // Tasca 26: per al botó "marcar totes com a fetes".
          liniesFetes: Number(totals.rows[0]?.linies_fetes ?? 0),
          liniesPendents:
            Number(totals.rows[0]?.linies ?? 0) - Number(totals.rows[0]?.linies_fetes ?? 0),
        },
        dades,
        paginacio: construirPaginacio(pagina, mida, Number(totals.rows[0]?.linies ?? 0)),
      };
    },
  );

  // Tasca 29 (03/10/2026): vista per defecte de l'Obrador, una fila per
  // producte amb la suma de les línies que compleixen els filtres. Mateixos
  // filtres i mateixos totals que GET /panells/obrador; sense paginar (com
  // a molt, una fila per article del catàleg).
  fastify.get(
    '/panells/obrador/acumulat',
    { preHandler: crearGuardaModul('panell-obrador') },
    async (req, reply) => {
      const filtres = await construirFiltresObrador(reply, req.query as Record<string, unknown>);
      if (filtres === null) return;
      const { condicions, valors } = filtres;

      const files = await pool.query<{
        producte_id_seq: string;
        producte_codi: string | null;
        producte_descripcio: string;
        agrupacio_produccio: string | null;
        unitats: string;
        kg: string;
        linies: string;
        linies_fetes: string;
      }>(
        `SELECT p.id_seq AS producte_id_seq, p.codi AS producte_codi,
                p.descripcio AS producte_descripcio, p.agrupacio_produccio,
                SUM(cl.unitats_demanades)::numeric(10,2) AS unitats,
                SUM(cl.pes_calculat_kg)::numeric(14,3) AS kg,
                count(*) AS linies,
                count(*) FILTER (WHERE cl.treballat_a IS NOT NULL) AS linies_fetes
         FROM comanda_linia cl
         JOIN comanda c ON c.id = cl.comanda_id
         JOIN producte p ON p.id = cl.producte_id
         WHERE ${condicions.join(' AND ')}
         GROUP BY p.id
         ORDER BY p.agrupacio_produccio ASC NULLS LAST, p.descripcio ASC`,
        valors,
      );

      const dades: FilaPanellObradorAcumulatApi[] = files.rows.map((f) => ({
        producte: {
          id: Number(f.producte_id_seq),
          codi: f.producte_codi,
          descripcio: f.producte_descripcio,
        },
        agrupacioProduccio: f.agrupacio_produccio,
        unitats: f.unitats,
        kg: f.kg,
        linies: Number(f.linies),
        liniesFetes: Number(f.linies_fetes),
      }));

      // Els totals surten de les mateixes files (mateixos filtres).
      const linies = dades.reduce((total, fila) => total + fila.linies, 0);
      const liniesFetes = dades.reduce((total, fila) => total + fila.liniesFetes, 0);
      const totals = await pool.query<{ total_unitats: string; total_kg: string }>(
        `SELECT COALESCE(SUM(cl.unitats_demanades), 0)::numeric(10,2) AS total_unitats,
                COALESCE(SUM(cl.pes_calculat_kg), 0)::numeric(14,3) AS total_kg
         FROM comanda_linia cl
         JOIN comanda c ON c.id = cl.comanda_id
         JOIN producte p ON p.id = cl.producte_id
         WHERE ${condicions.join(' AND ')}`,
        valors,
      );

      return {
        totals: {
          linies,
          totalUnitats: totals.rows[0]?.total_unitats ?? '0.00',
          totalKg: totals.rows[0]?.total_kg ?? '0.000',
          liniesFetes,
          liniesPendents: linies - liniesFetes,
        },
        dades,
      };
    },
  );

  // ── 4.8 · Panell Empaquetat (único con edición — GET es sólo lectura, PATCH en lliurament.ts) ──
  fastify.get(
    '/panells/empaquetat',
    { preHandler: crearGuardaModul('panell-empaquetat') },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const { pagina, mida, offset } = parsearPaginacio(query);

      // Fora: cancel·lades i esborranys (tasca 33), mateix criteri que Obrador.
      const condicions: string[] = [
        'NOT cl.esborrat',
        `c.estat NOT IN ('cancellada', 'esborrany')`,
      ];
      const valors: unknown[] = [];

      if (typeof query.dataExpedicioDes === 'string' && query.dataExpedicioDes !== '') {
        condicions.push(`c.data_expedicio >= $${valors.length + 1}`);
        valors.push(query.dataExpedicioDes);
      }
      if (typeof query.dataExpedicioFins === 'string' && query.dataExpedicioFins !== '') {
        condicions.push(condicioDataFinsInclusiva('c.data_expedicio', valors.length + 1));
        valors.push(query.dataExpedicioFins);
      }
      // Mismo criterio que dataExpedicioDes/Fins de arriba, sobre la fecha
      // de entrega del pedido.
      if (typeof query.dataLliuramentDes === 'string' && query.dataLliuramentDes !== '') {
        condicions.push(`c.data_lliurament >= $${valors.length + 1}`);
        valors.push(query.dataLliuramentDes);
      }
      if (typeof query.dataLliuramentFins === 'string' && query.dataLliuramentFins !== '') {
        condicions.push(condicioDataFinsInclusiva('c.data_lliurament', valors.length + 1));
        valors.push(query.dataLliuramentFins);
      }
      // Un o més transportistes (tasca 22): OR entre ells.
      const transportistaUuids = await resolverFiltreEntitats(
        reply,
        query.transportistaId,
        'transportistaId',
        (id) => resolverTransportistaUuid(pool, id),
      );
      if (transportistaUuids === null) return;
      if (transportistaUuids !== undefined) {
        condicions.push(`c.transportista_id = ANY($${valors.length + 1}::uuid[])`);
        valors.push(transportistaUuids);
      }
      const clientUuid = await resolverFiltreEntitat(reply, query.clientId, 'clientId', (id) =>
        resolverClientUuid(pool, id),
      );
      if (clientUuid === null) return;
      if (clientUuid !== undefined) {
        condicions.push(`c.client_id = $${valors.length + 1}`);
        valors.push(clientUuid);
      }
      afegirFiltreProductes(query.producte, condicions, valors);
      // Peticions d'Ari (29/09/2026): categoria de l'article (mateix criteri
      // que a /panells/obrador) i línies pendents / ja enviades.
      const categoriaUuid = await resolverFiltreEntitat(
        reply,
        query.categoriaId,
        'categoriaId',
        (id) => resolverCategoriaUuid(pool, id),
      );
      if (categoriaUuid === null) return;
      if (categoriaUuid !== undefined) {
        condicions.push(`p.categoria_id = $${valors.length + 1}`);
        valors.push(categoriaUuid);
      }
      if (query.confirmacio !== undefined && query.confirmacio !== '') {
        if (query.confirmacio === 'pendents') {
          condicions.push('cl.confirmat_a IS NULL');
        } else if (query.confirmacio === 'confirmades') {
          condicions.push('cl.confirmat_a IS NOT NULL');
        } else {
          return enviarValidacio(reply, 'confirmacio ha de ser pendents o confirmades', [
            { camp: 'confirmacio', missatge: 'ha de ser pendents o confirmades' },
          ]);
        }
      }
      // Tasca 23 (01/10/2026): línies amb / sense observacions d'EMPAQUETAT
      // (camp de línia de la tasca 7).
      const ambObservacions = `COALESCE(TRIM(cl.obs_empaquetat), '') <> ''`;
      if (query.observacions === 'si') condicions.push(ambObservacions);
      else if (query.observacions === 'no') condicions.push(`NOT ${ambObservacions}`);
      else if (query.observacions !== undefined && query.observacions !== '') {
        return enviarValidacio(reply, 'observacions ha de ser si o no', [
          { camp: 'observacions', missatge: 'ha de ser si o no' },
        ]);
      }
      const where = `WHERE ${condicions.join(' AND ')}`;

      const base = `
      FROM comanda_linia cl
      JOIN comanda c ON c.id = cl.comanda_id
      LEFT JOIN client cli ON cli.id = c.client_id
      LEFT JOIN transportista tr ON tr.id = c.transportista_id
      LEFT JOIN producte p ON p.id = cl.producte_id
      LEFT JOIN categoria_producte cat ON cat.id = p.categoria_id
      ${where}
    `;

      const totals = await pool.query<{
        linies: string;
        unitats_demanades: string;
        unitats_lliurades: string;
        kg_demanats: string;
        kg_lliurats: string;
        linies_confirmades: string;
      }>(
        // unitats_demanades/unitats_lliurades ahora son NUMERIC(10,2) (antes
        // INTEGER): mismos casts explícitos que ya tenían kg_demanades/
        // kg_lliurats, por el mismo motivo (evitar sumar en JS con floats).
        `SELECT count(*) AS linies,
              COALESCE(SUM(cl.unitats_demanades), 0)::numeric(10,2) AS unitats_demanades,
              COALESCE(SUM(cl.unitats_lliurades), 0)::numeric(10,2) AS unitats_lliurades,
              COALESCE(SUM(cl.pes_calculat_kg), 0)::numeric(14,3) AS kg_demanats,
              COALESCE(SUM(cl.kg_lliurats), 0)::numeric(14,3) AS kg_lliurats,
              count(*) FILTER (WHERE cl.confirmat_a IS NOT NULL) AS linies_confirmades
       ${base}`,
        valors,
      );

      const files = await pool.query<{
        id_seq: string;
        comanda_id_seq: string;
        num: string;
        data_expedicio: Date | null;
        data_lliurament: Date | null;
        transportista_nom: string | null;
        client_nom: string | null;
        categoria_nom: string | null;
        codi: string | null;
        descripcio: string | null;
        unitats_demanades: string;
        kg_demanats: string;
        unitats_lliurades: string;
        kg_lliurats: string;
        confirmat_a: Date | null;
        confirmat_per: string | null;
        obs_empaquetat: string | null;
      }>(
        `SELECT cl.id_seq, c.id_seq AS comanda_id_seq, c.num, c.data_expedicio, c.data_lliurament,
              tr.nom AS transportista_nom, cli.nom AS client_nom, cat.nom AS categoria_nom,
              p.codi, p.descripcio,
              cl.unitats_demanades, cl.pes_calculat_kg AS kg_demanats, cl.unitats_lliurades,
              cl.kg_lliurats, cl.confirmat_a, cl.confirmat_per, cl.obs_empaquetat
       ${base}
       -- Mismo criterio que /panells/obrador (ver comentario ahí): pendents
       -- (confirmat_a IS NULL) primer, per defecte, sense tocar la resta de
       -- l'ordre existent.
       ORDER BY (cl.confirmat_a IS NOT NULL) ASC,
                c.data_expedicio ASC NULLS LAST, c.num ASC, cl.ordinal ASC
       LIMIT $${valors.length + 1} OFFSET $${valors.length + 2}`,
        [...valors, mida, offset],
      );

      const totalLinies = Number(totals.rows[0]?.linies ?? 0);
      const liniesConfirmades = Number(totals.rows[0]?.linies_confirmades ?? 0);

      const dades: FilaPanellEmpaquetatApi[] = files.rows.map((f) => ({
        liniaId: Number(f.id_seq),
        comandaId: Number(f.comanda_id_seq),
        num: f.num,
        dataExpedicio: formatearDataApi(f.data_expedicio),
        dataLliurament: formatearDataApi(f.data_lliurament),
        transportista: f.transportista_nom,
        client: f.client_nom,
        categoria: f.categoria_nom,
        codi: f.codi,
        producte: f.descripcio ?? '',
        unitatsDemanades: f.unitats_demanades,
        kgDemanats: f.kg_demanats,
        unitatsLliurades: f.unitats_lliurades,
        kgLliurats: f.kg_lliurats,
        confirmatA: formatearDataApi(f.confirmat_a),
        // Sin tabla de usuarios todavía: se muestra el uid real de Firebase
        // (o el marcador de desarrollo con AUTH_DISABLED),
        // no un nombre — no hay ningún directorio del que sacarlo.
        confirmatPer: f.confirmat_per,
        obsEmpaquetat: f.obs_empaquetat,
      }));

      return {
        totals: {
          linies: totalLinies,
          // String desde ahora (ver nota en el SELECT de arriba).
          unitatsDemanades: totals.rows[0]?.unitats_demanades ?? '0.00',
          unitatsLliurades: totals.rows[0]?.unitats_lliurades ?? '0.00',
          kgDemanats: totals.rows[0]?.kg_demanats ?? '0.000',
          kgLliurats: totals.rows[0]?.kg_lliurats ?? '0.000',
          liniesConfirmades,
          liniesPendents: totalLinies - liniesConfirmades,
        },
        dades,
        paginacio: construirPaginacio(pagina, mida, totalLinies),
      };
    },
  );

  // ── 4.10 · Panell Producció ──────────────────────────────────────────
  fastify.get(
    '/panells/produccio',
    { preHandler: crearGuardaModul('panell-produccio') },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const { pagina, mida, offset } = parsearPaginacio(query);

      // Calculadora interactiva: sin nombrePorcs no hay nada que calcular —
      // un default silencioso podría hacer pensar al usuario que un número
      // inventado es el resultado real. Se exige explícito, siempre.
      const nombrePorcs = typeof query.nombrePorcs === 'string' ? Number(query.nombrePorcs) : NaN;
      if (!Number.isFinite(nombrePorcs) || nombrePorcs <= 0) {
        return enviarValidacio(reply, 'nombrePorcs és obligatori i ha de ser més gran que zero', [
          { camp: 'nombrePorcs', missatge: 'és obligatori i ha de ser més gran que zero' },
        ]);
      }

      if (
        query.agrupacioRendiment !== undefined &&
        query.agrupacioRendiment !== '' &&
        !esAgrupacioRendimentValida(query.agrupacioRendiment)
      ) {
        return enviarValidacio(
          reply,
          `agrupacioRendiment ha de ser ${AGRUPACIONS_RENDIMENT.join(', ')}`,
        );
      }

      const condicions: string[] = [
        // Oberta i esborrany (tasca 33: l'esborrany sí compta a Producció).
        `c.estat IN ('oberta', 'esborrany')`,
        'cat.elaborat_porc = true',
        'NOT cl.esborrat',
        // agrupacioProduccio/agrupacioRendiment son NO nulables en
        // PanellProduccioFilaApi (contrato) — una línia cuyo producte no
        // tiene agrupació de producció, o cuya categoria no tiene agrupació
        // de rendiment, no tiene con qué rellenar esos campos. Mismo
        // criterio que rendiments-porcs.ts: queda fuera en vez de romper el
        // contrato con un null donde no lo admite.
        'p.agrupacio_produccio IS NOT NULL',
        'cat.agrupacio_rendiment IS NOT NULL',
      ];
      const valors: unknown[] = [];

      // Principio confirmado por el cliente: "sin datos = todos los datos",
      // para TODOS los filtros del sistema. Acá
      // significa que sin dataDes NI dataFins no se agrega NINGUNA condición
      // de fecha (antes se sustituía por un rango oculto interno, mañana a
      // +7 días, vía dataIsoAmbOffset — eso ocultaba líneas elegibles fuera de
      // ese rango sin que el usuario lo pidiera). Si viene sólo uno de los
      // dos, se aplica sólo esa mitad — mismo patrón condicional que el resto
      // de filtros de este archivo (agrupacioRendiment/producte, más abajo).
      // ::date descarta la hora — dataDes/dataFins son fechas, no instantes, y
      // así funciona sin importar si vienen como "YYYY-MM-DD" o un timestamp
      // completo.
      if (typeof query.dataDes === 'string' && query.dataDes !== '') {
        condicions.push(`cl.data_produccio::date >= $${valors.length + 1}::date`);
        valors.push(query.dataDes);
      }
      if (typeof query.dataFins === 'string' && query.dataFins !== '') {
        condicions.push(`cl.data_produccio::date <= $${valors.length + 1}::date`);
        valors.push(query.dataFins);
      }

      if (query.agrupacioRendiment !== undefined && query.agrupacioRendiment !== '') {
        condicions.push(`cat.agrupacio_rendiment = $${valors.length + 1}`);
        valors.push(query.agrupacioRendiment);
      }
      if (typeof query.producte === 'string' && query.producte.trim() !== '') {
        // Coincidencia EXACTA por descripción, no substring — mismo criterio
        // corregido en rendiments-porcs.ts.
        condicions.push(`LOWER(p.descripcio) = LOWER($${valors.length + 1})`);
        valors.push(query.producte.trim());
      }
      const where = `WHERE ${condicions.join(' AND ')}`;

      // Agrupado por agrupacio_produccio + agrupacio_rendiment (no por
      // producte_id): varios artículos pueden compartir una misma agrupación
      // de producción — por eso `producte` YA NO viaja en la respuesta (ver
      // PanellProduccioFilaApi, BREAKING). `categoria_nom`
      // sigue sin estar en el GROUP BY (que es por agrupacio_produccio, no por
      // categoria_id) y sigue necesitando un array_agg — issues #3/#4 no
      // tocaron esto, cat.nom es constante dentro del grupo por la misma
      // invariante de negocio (un agrupacio_produccio no cruza categorías),
      // pero Postgres no puede inferirlo, sigue exigiendo un agregado.
      //
      // unitats_per_porc/kg_per_unitat SÍ cambiaron (issues #3/#4): el join
      // ahora es categoria_id + agrupacio_produccio, la MISMA UNIQUE de
      // rendiments_porcs — como mucho una fila de rp por grupo, así que
      // MAX() alcanza (nunca hay más de un valor no-nulo que desempatar,
      // a diferencia del array_agg(...)[1] ORDER BY p.id_seq de antes, que
      // elegía un producte arbitrario cuando varios del grupo competían por
      // la única fila de rp que existiera).
      const filas = await pool.query<{
        agrupacio_produccio: string;
        agrupacio_rendiment: AgrupacioRendiment;
        categoria_nom: string;
        unitats_per_porc: string | null;
        kg_per_unitat: string | null;
        kg_a_elaborar: string;
        paq_pedido: string;
      }>(
        `SELECT p.agrupacio_produccio, cat.agrupacio_rendiment,
              (array_agg(cat.nom ORDER BY p.id_seq))[1] AS categoria_nom,
              MAX(rp.unitats_per_porc) AS unitats_per_porc,
              MAX(rp.kg_per_unitat) AS kg_per_unitat,
              SUM(cl.pes_calculat_kg)::numeric(14,3) AS kg_a_elaborar,
              SUM(cl.unitats_demanades) AS paq_pedido
       FROM comanda_linia cl
       JOIN comanda c ON c.id = cl.comanda_id
       JOIN producte p ON p.id = cl.producte_id
       JOIN categoria_producte cat ON cat.id = p.categoria_id
       LEFT JOIN rendiments_porcs rp
         ON rp.categoria_id = p.categoria_id AND rp.agrupacio_produccio = p.agrupacio_produccio
       ${where}
       GROUP BY p.agrupacio_produccio, cat.agrupacio_rendiment
       ORDER BY p.agrupacio_produccio ASC`,
        valors,
      );

      // Sumatorio de CANALS — completamente independiente del resto del
      // panel: CANALS tiene elaborat_porc=false A PROPÓSITO, así que queda
      // fuera de `condicions`/`filas` de arriba (esa
      // query exige elaborat_porc=true, agrupacio_produccio y
      // agrupacio_rendiment no nulos — los productos de CANALS no cumplen
      // ninguna de las tres). Por eso es una query aparte, no una variante de
      // la de arriba. Único filtro que comparte con el resto del panel:
      // dataDes/dataFins (mismo criterio "sin fecha = todas", issue #18) — ni
      // agrupacioRendiment ni producte ni la categoria de la tabla principal
      // le aplican.
      // Tasca 36 (03/10/2026): les mitges canals tenen la seva pròpia
      // categoria ("MITJES CANALS") i el seu propi total, amb exactament el
      // mateix càlcul que CANALS.
      const sumarCategoriaCanals = async (
        nomCategoria: string,
      ): Promise<{ unitats: string; kg: string }> => {
        const condicionsCanals: string[] = [
          `cat.nom = $1`,
          'NOT cl.esborrat',
          `c.estat IN ('oberta', 'esborrany')`,
        ];
        const valorsCanals: unknown[] = [nomCategoria];
        if (typeof query.dataDes === 'string' && query.dataDes !== '') {
          condicionsCanals.push(`cl.data_produccio::date >= $${valorsCanals.length + 1}::date`);
          valorsCanals.push(query.dataDes);
        }
        if (typeof query.dataFins === 'string' && query.dataFins !== '') {
          condicionsCanals.push(`cl.data_produccio::date <= $${valorsCanals.length + 1}::date`);
          valorsCanals.push(query.dataFins);
        }
        const canals = await pool.query<{ unitats: string | null; kg: string | null }>(
          `SELECT SUM(cl.unitats_demanades) AS unitats, SUM(cl.pes_calculat_kg)::numeric(14,3) AS kg
         FROM comanda_linia cl
         JOIN comanda c ON c.id = cl.comanda_id
         JOIN producte p ON p.id = cl.producte_id
         JOIN categoria_producte cat ON cat.id = p.categoria_id
         WHERE ${condicionsCanals.join(' AND ')}`,
          valorsCanals,
        );
        // Sin líneas que matcheen: SUM() de Postgres da NULL, no 0 — se
        // normaliza acá para que el contrato nunca traiga null (mismo criterio
        // que el resto de los totales de este panel, todos string siempre).
        return {
          unitats: canals.rows[0]?.unitats ?? '0',
          kg: canals.rows[0]?.kg ?? '0',
        };
      };
      const totalsCanals = await sumarCategoriaCanals('CANALS');
      const totalsMitgesCanals = await sumarCategoriaCanals('MITJES CANALS');

      let totalKgAElaborarNum = 0;
      const dadesCompletes: PanellProduccioFilaApi[] = filas.rows.map((f) => {
        const unitatsPerPorc = f.unitats_per_porc !== null ? Number(f.unitats_per_porc) : null;
        const kgPerUnitat = f.kg_per_unitat !== null ? Number(f.kg_per_unitat) : null;

        if (f.agrupacio_rendiment === 'PAQ') {
          let rendiment: string | null = null;
          let diferencia: string | null = null;
          if (unitatsPerPorc !== null) {
            const rendimentNum = unitatsPerPorc * nombrePorcs;
            rendiment = rendimentNum.toFixed(2);
            diferencia = (rendimentNum - Number(f.paq_pedido)).toFixed(2);
          }
          return {
            agrupacioRendiment: f.agrupacio_rendiment,
            categoria: f.categoria_nom,
            agrupacioProduccio: f.agrupacio_produccio,
            paqPedido: Number(f.paq_pedido).toFixed(2),
            kgAElaborar: null,
            rendiment,
            diferencia,
          };
        }

        let rendiment: string | null = null;
        let diferencia: string | null = null;
        if (f.agrupacio_rendiment === 'KG') {
          if (unitatsPerPorc !== null && kgPerUnitat !== null) {
            const rendimentNum = unitatsPerPorc * kgPerUnitat * nombrePorcs;
            rendiment = rendimentNum.toFixed(3);
            diferencia = (rendimentNum - Number(f.kg_a_elaborar)).toFixed(3);
          }
        } else {
          // MAGRE: no hay cálculo por fila (rendiment/diferencia quedan
          // null) — a diferencia de KG, acá `rendiments_porcs` no alimenta
          // ningún total de cabecera. "Total Kg Magre" (totals.totalKgMagro)
          // es la suma de kgJamon/kgRecortes/kgPaletillas, 3 tasas FIJAS de
          // negocio — ver el comentario junto a esas constantes, más arriba
          // (NO reconectar esto a rendiments_porcs).
          //
          // ADVERTENCIA — "Total Kg a elaborar" (la tarjeta que se compara
          // contra "Total Kg Magre"/"Diferència") suma EXCLUSIVAMENTE MAGRE,
          // nunca KG. Si se acumula más arriba, fuera de este if/else, para
          // KG+MAGRE juntas, el bug sólo se nota con "Totes" o "KG"
          // seleccionados (con agrupacioRendiment=MAGRE explícito ya da bien,
          // porque `filas` sólo trae MAGRE en ese caso) — fácil de no
          // detectar en una prueba superficial. La columna "Kg a Elaborar" de
          // CADA FILA (`kgAElaborar` más abajo, `f.kg_a_elaborar` crudo) es
          // un campo completamente aparte — sigue igual para KG y MAGRE, sin
          // tocar.
          totalKgAElaborarNum += Number(f.kg_a_elaborar);
        }

        return {
          agrupacioRendiment: f.agrupacio_rendiment,
          categoria: f.categoria_nom,
          agrupacioProduccio: f.agrupacio_produccio,
          paqPedido: null,
          kgAElaborar: f.kg_a_elaborar,
          rendiment,
          diferencia,
        };
      });

      const dades = dadesCompletes.slice(offset, offset + mida);

      // Rendimiento fijo por cerdo (ver constantes arriba). nombrePorcs ya
      // está validado como obligatorio y > 0 más arriba en el handler, así
      // que estos tres campos siempre traen un valor.
      //
      // ADVERTENCIA — totalKgMagro es la suma directa de estas 3 tasas
      // fijas, NO un acumulado desde rendiments_porcs (ver comentario junto
      // a las constantes: ya se intentó conectarlo y se revirtió). Con
      // nombrePorcs=1: 12+6+7=25.000.
      const kgJamonNum = KG_JAMON_PER_CERDO * nombrePorcs;
      const kgRecortesNum = KG_RECORTES_PER_CERDO * nombrePorcs;
      const kgPaletillasNum = KG_PALETILLAS_PER_CERDO * nombrePorcs;
      const totalKgMagroNum = kgJamonNum + kgRecortesNum + kgPaletillasNum;

      return {
        totals: {
          totalKgAElaborar: totalKgAElaborarNum.toFixed(3),
          totalKgMagro: totalKgMagroNum.toFixed(3),
          diferencia: (totalKgMagroNum - totalKgAElaborarNum).toFixed(3),
          kgJamon: kgJamonNum.toFixed(3),
          kgRecortes: kgRecortesNum.toFixed(3),
          kgPaletillas: kgPaletillasNum.toFixed(3),
          canals: totalsCanals,
          mitgesCanals: totalsMitgesCanals,
        },
        dades,
        paginacio: construirPaginacio(pagina, mida, dadesCompletes.length),
      };
    },
  );
}
