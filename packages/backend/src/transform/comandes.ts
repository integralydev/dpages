import type { Pool, PoolClient } from 'pg';
import type { WooOrder } from '@dpages/shared';
import { env } from '../config/env.js';
import { pool as poolPerDefecte } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { parsearFechaGmt } from '../sync/fechas.js';
import { calcularDataProduccioWoo } from './data-produccio-woo.js';
import { calcularPesLinia } from './pes.js';
import { resolverArticle } from './resolucio-article.js';
import { ConflicteIdentitatClient, resolverOCrearClient } from './resolucio-client.js';
import type { IndexConflicteClient } from './resolucio-client.js';

export interface ResultatComanda {
  /** null = se omitió por el piso de activación — nunca se tocó la base, no hay fila que referenciar. */
  comandaId: string | null;
  /** true = había congelat_a; no se tocó ni cabecera ni líneas, se registró incidencia. */
  congelada: boolean;
  /** false = se descartó por guardián de versión (no es un error, es lo esperado con entregas fuera de orden). */
  actualitzada: boolean;
  liniesNoResoltes: number;
  /**
   * Piso de activación (ver `resolverPisoActivacio`): true = el pedido es
   * anterior al piso de fecha de creación, o su `date_created_gmt` no se
   * pudo determinar con certeza — en los dos casos se omite por completo
   * (sin comanda, sin cliente nuevo, sin incidencia), nunca se llega a
   * tomar el lock ni a tocar la base.
   */
  omesaPerPisoActivacio: boolean;
  /** ADR-026: true = Oficina ya editó una línea de este pedido — processarLinies no corrió, sólo se actualizó la cabecera. */
  liniesProtegides: boolean;
}

export interface ResultatTransformacioComandes {
  comandesProcessades: number;
  comandesActualitzades: number;
  comandesCongelades: number;
  comandesDescartadesPerVersio: number;
  /** Piso de activación: pedidos anteriores a la fecha de creación mínima, o con date_created_gmt indeterminable. */
  comandesOmesesPerData: number;
  /** ADR-026: pedidos con `linies_editades_a` fijada — se actualizó la cabecera, nunca las líneas. */
  comandesLiniesProtegides: number;
  liniesNoResoltes: number;
  errors: number;
}

interface FilaComandaExistent {
  id: string;
  congelat_a: Date | null;
  /** Para que una línea agregada tarde (`processarLinies`) herede la misma fecha que ya tiene la cabecera — ver ADR-025/tarea del 08/10/2026. */
  data_produccio: Date | null;
  /** ADR-026: no nula = Oficina ya editó una línea de este pedido — el sync deja de tocar líneas. */
  linies_editades_a: Date | null;
}

async function obtenirComandaExistent(
  client: PoolClient,
  wooOrderId: number,
): Promise<FilaComandaExistent | null> {
  const res = await client.query<FilaComandaExistent>(
    'SELECT id, congelat_a, data_produccio, linies_editades_a FROM comanda WHERE woo_order_id = $1',
    [wooOrderId],
  );
  return res.rows[0] ?? null;
}

/**
 * "Se registra como incidencia" (ADR-007 y resolución de artículo): queda
 * un registro consultable, no sólo la marca en `estat`. `estat` se pisa a
 * 'amb_incidencia' aunque la comanda ya estuviera en otro estado — es la
 * señal para oficina de que hay algo que mirar. Excepciones (la incidencia
 * se registra igual): una comanda 'cancellada' sigue cancelada, si no el
 * sync la volvería a meter en los paneles; y una 'esborrany' sigue en
 * esborrany (tarea 38), si no entraría en Obrador y Empaquetat antes de que
 * oficina la revise — al revisarla ya verá la incidencia.
 */
async function registrarIncidencia(
  client: PoolClient,
  comandaId: string,
  tipus: string,
  detall: string,
): Promise<void> {
  await client.query(
    `INSERT INTO incidencia_comanda (comanda_id, tipus, detall) VALUES ($1, $2, $3)`,
    [comandaId, tipus, detall],
  );
  await client.query(
    `UPDATE comanda SET estat = 'amb_incidencia' WHERE id = $1 AND estat NOT IN ('cancellada', 'esborrany')`,
    [comandaId],
  );
}

/**
 * ADR-020: sin NIF ni email resoluble no hay cliente que vincular — no es
 * un error, pero tampoco puede quedar invisible para siempre. Se registra
 * como incidencia (mismo patrón que `incidencia_cataleg` para "sin SKU")
 * para que oficina lo encuentre y lo complete a mano. La comprobación
 * previa evita acumular una fila nueva en cada corrida mientras el pedido
 * siga sin datos de cliente — `resolverOCrearClient` se reintenta en TODA
 * transformación (no está detrás del guardián de versión), así que sin
 * este chequeo se repetiría en cada ciclo de sync.
 */
async function registrarIncidenciaSenseDadesClientSiFalta(
  client: PoolClient,
  comandaId: string,
): Promise<void> {
  const existent = await client.query(
    `SELECT 1 FROM incidencia_comanda WHERE comanda_id = $1 AND tipus = 'sense_dades_client' AND NOT resolta`,
    [comandaId],
  );
  if ((existent.rowCount ?? 0) > 0) return;

  await registrarIncidencia(
    client,
    comandaId,
    'sense_dades_client',
    'El pedido no trae NIF (meta_data) ni email (billing.email) resoluble — no se pudo vincular ningún client.',
  );
}

/**
 * ADR-023: hasta esta versión, un conflicto de identidad (`resolverOCrearClient`
 * lanzando `ConflicteIdentitatClient`) hacía ROLLBACK del pedido entero —
 * con ~10% de los pedidos reales golpeando esto, se estaban perdiendo en
 * silencio. Mismo patrón que `sense_dades_client`: se registra la
 * incidencia y el pedido sigue existiendo con `client_id` en null, en vez
 * de desaparecer. El chequeo de idempotencia evita acumular una fila nueva
 * en cada corrida mientras el conflicto siga sin resolverse a mano.
 */
async function registrarIncidenciaConflicteIdentitatSiFalta(
  client: PoolClient,
  comandaId: string,
  index: IndexConflicteClient,
): Promise<void> {
  const existent = await client.query(
    `SELECT 1 FROM incidencia_comanda WHERE comanda_id = $1 AND tipus = 'conflicte_identitat_client' AND NOT resolta`,
    [comandaId],
  );
  if ((existent.rowCount ?? 0) > 0) return;

  await registrarIncidencia(
    client,
    comandaId,
    'conflicte_identitat_client',
    `El NIF/email/woo_customer_id resuelto para este pedido choca con el índice único "${index}" de un cliente distinto ya registrado.`,
  );
}

/**
 * `origen_comanda` (sembrado por seed-arranque.ts) reemplaza la columna
 * vieja `origen` (deprecated desde la migración 0013) — todo pedido que
 * entra por este transformador viene de WooCommerce, así que siempre
 * resuelve al mismo codi fijo.
 */
async function resolverOrigenWoocommerceUuid(client: PoolClient): Promise<string> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM origen_comanda WHERE codi = 'woocommerce'`,
  );
  if (!res.rows[0]) {
    throw new Error(
      `No existe la fila origen_comanda con codi='woocommerce' — falta correr seed-arranque.ts`,
    );
  }
  return res.rows[0].id;
}

/**
 * ADR-025 (decidido internamente, pendiente de validación del cliente):
 * `address_1 + ", " + address_2 (si no está vacío) + ", " + postcode (si no
 * está vacío)` — sin city (ya va en `poblacio_desti`), sin comas colgando.
 * `null` si `address_1` falta/está vacío, o si el pedido tiene recogida en
 * tienda (`shipping_lines` con `method_id === 'local_pickup'`, ver
 * docs/hallazgos-woocommerce.md): no tiene sentido una dirección de entrega
 * para un pedido que el cliente retira en el local.
 */
export function construirAdrecaLliurament(wooOrder: WooOrder): string | null {
  // Defensivo a propósito: `shipping` es obligatorio en el tipo `WooOrder`,
  // pero el tipo es sólo de compilación — un payload real que lo omitiera
  // del todo no debe tirar, sólo dejar la dirección sin armar.
  const esRecollidaLocal = (wooOrder.shipping_lines ?? []).some(
    (l) => l.method_id === 'local_pickup',
  );
  if (esRecollidaLocal) return null;

  const address1 = wooOrder.shipping?.address_1?.trim();
  if (!address1) return null;

  const address2 = wooOrder.shipping?.address_2?.trim();
  const postcode = wooOrder.shipping?.postcode?.trim();

  return [address1, address2, postcode].filter((part) => !!part).join(', ');
}

/** ADR-025: nota del cliente, tal cual, sólo con trim. `null` si falta o está vacía. */
export function construirObsLliurament(wooOrder: WooOrder): string | null {
  const nota = wooOrder.customer_note?.trim();
  return nota ? nota : null;
}

async function crearComanda(
  client: PoolClient,
  wooOrder: WooOrder,
  clientId: string | null,
  dataProduccio: Date | null,
): Promise<string> {
  // Tarea 38 (03/10/2026): toda comanda de WooCommerce nace en esborrany —
  // oficina la revisa y la pasa a oberta, y sólo entonces cuenta en
  // Obrador y Empaquetat.
  const origenId = await resolverOrigenWoocommerceUuid(client);
  const res = await client.query<{ id: string }>(
    `INSERT INTO comanda (woo_order_id, origen_id, estat, estat_web, poblacio_desti, total, data_modificacio_woo, client_id, data_comanda, data_produccio, adreca_lliurament, obs_lliurament)
     VALUES ($1, $2, 'esborrany', $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      wooOrder.id,
      origenId,
      wooOrder.status,
      wooOrder.shipping.city,
      wooOrder.total,
      parsearFechaGmt(wooOrder.date_modified_gmt),
      clientId,
      // Issue #16 — comanda.data_comanda es NOT NULL desde la migración
      // 0019. Para un pedido que entra por WooCommerce, date_created_gmt
      // (cuándo el cliente hizo el pedido de verdad, en la tienda) es el
      // proxy correcto — mejor que date_modified_gmt (cambia con cada
      // actualización posterior) o que "ahora" (el momento del sync, que
      // puede ir minutos u horas detrás del pedido real).
      parsearFechaGmt(wooOrder.date_created_gmt),
      dataProduccio,
      construirAdrecaLliurament(wooOrder),
      construirObsLliurament(wooOrder),
    ],
  );
  return res.rows[0]!.id;
}

/**
 * Vincula el cliente a una comanda ya existente que todavía no lo tiene —
 * A PROPÓSITO no pasa por el guardián de versión (ADR-004): resolver y
 * vincular el cliente no es un dato "de versión" que deba esperar una
 * actualización más nueva de WooCommerce, es un backfill idempotente que
 * tiene que poder correr incluso cuando la cabecera ya está al día. Nunca
 * pisa un client_id ya asignado.
 */
async function vincularClientSiFalta(
  client: PoolClient,
  comandaId: string,
  clientId: string | null,
): Promise<void> {
  if (clientId === null) return;
  await client.query(`UPDATE comanda SET client_id = $2 WHERE id = $1 AND client_id IS NULL`, [
    comandaId,
    clientId,
  ]);
}

/**
 * Guardián de versión (ADR-004) + propiedad de columnas (ADR-005) en una
 * sola sentencia atómica: el UPDATE sólo toca columnas que el sync tiene
 * permitido tocar (estado web, población destino, total — "unidades
 * pedidas" y "precio unitario" son de línea, ver processarLinies), y sólo
 * aplica si la comanda no está congelada y la versión entrante es más
 * nueva que la almacenada. Nunca se lee primero y se decide después: la
 * condición va en el propio WHERE para que sea atómica.
 *
 * ADR-025: `adreca_lliurament`/`obs_lliurament` A PROPÓSITO no están en este
 * UPDATE — sólo se escriben una vez, al crear (`crearComanda`). Después son
 * de Oficina (mismo criterio de propiedad de columnas que ya aplica acá):
 * una actualización posterior de WooCommerce nunca pisa lo que Oficina haya
 * corregido a mano, aunque la versión entrante sea más nueva.
 */
async function actualitzarCapcaleraSiCorrespon(
  client: PoolClient,
  comandaId: string,
  wooOrder: WooOrder,
): Promise<boolean> {
  const dataModificacio = parsearFechaGmt(wooOrder.date_modified_gmt);
  const res = await client.query(
    `UPDATE comanda SET
       estat_web = $2,
       poblacio_desti = $3,
       total = $4,
       data_modificacio_woo = $5
     WHERE id = $1
       AND congelat_a IS NULL
       AND (data_modificacio_woo IS NULL OR data_modificacio_woo < $5)`,
    [comandaId, wooOrder.status, wooOrder.shipping.city, wooOrder.total, dataModificacio],
  );
  return (res.rowCount ?? 0) > 0;
}

interface FilaLiniaExistentCruda {
  id: string;
  /** pg devuelve BIGINT como string (no cabe siempre en un number de JS de forma segura) — se normaliza al leer. */
  woo_line_item_id: string | null;
  producte_id: string | null;
  ordinal: number;
}

interface FilaLiniaExistent {
  id: string;
  wooLineItemId: number | null;
  producteId: string | null;
  ordinal: number;
}

/**
 * Líneas: nunca DELETE+INSERT (ADR-006). Emparejamiento por
 * woo_line_item_id primero (pero esos ids no son estables cuando se edita
 * el pedido desde el admin de WooCommerce); si no coincide, por
 * (producte_id, ordinal). Las que no vienen más se marcan esborrat, nunca
 * se eliminan físicamente — borraría los kilos/unidades que empaquetado ya
 * haya registrado.
 */
async function processarLinies(
  client: PoolClient,
  comandaId: string,
  wooOrder: WooOrder,
  dataProduccioNoves: Date | null,
): Promise<{ liniesNoResoltes: number }> {
  const crudas = await client.query<FilaLiniaExistentCruda>(
    `SELECT id, woo_line_item_id, producte_id, ordinal FROM comanda_linia WHERE comanda_id = $1 AND NOT esborrat`,
    [comandaId],
  );
  const existents: FilaLiniaExistent[] = crudas.rows.map((e) => ({
    id: e.id,
    wooLineItemId: e.woo_line_item_id === null ? null : Number(e.woo_line_item_id),
    producteId: e.producte_id,
    ordinal: e.ordinal,
  }));

  const usades = new Set<string>();
  let noResoltes = 0;

  for (let ordinal = 0; ordinal < wooOrder.line_items.length; ordinal++) {
    const item = wooOrder.line_items[ordinal]!;
    const sku = item.sku && item.sku.trim() !== '' ? item.sku.trim() : null;
    const resolucio = await resolverArticle(client, item.product_id, item.variation_id, sku);
    if (!resolucio) noResoltes++;

    let pesFitxaKg: string | null = null;
    if (resolucio) {
      const producte = await client.query<{ pes_kg: string | null }>(
        'SELECT pes_kg FROM producte WHERE id = $1',
        [resolucio.producteId],
      );
      pesFitxaKg = producte.rows[0]?.pes_kg ?? null;
    }
    const pes = calcularPesLinia(item.quantity, pesFitxaKg);
    const preuUnitari = item.price.toFixed(2);

    let existent = existents.find((e) => !usades.has(e.id) && e.wooLineItemId === item.id);
    if (!existent && resolucio) {
      existent = existents.find(
        (e) => !usades.has(e.id) && e.producteId === resolucio.producteId && e.ordinal === ordinal,
      );
    }

    const valores = [
      ordinal,
      item.id,
      resolucio?.producteId ?? null,
      resolucio?.aliasProducteId ?? null,
      item.product_id,
      item.variation_id,
      sku,
      item.quantity,
      preuUnitari,
      pes.pesFitxaKg,
      pes.pesCalculatKg,
      pes.pesEditable,
    ];

    if (existent) {
      usades.add(existent.id);
      await client.query(
        `UPDATE comanda_linia SET
           ordinal = $2, woo_line_item_id = $3, producte_id = $4, alias_producte_id = $5,
           woo_product_id = $6, woo_variation_id = $7, woo_sku = $8,
           unitats_demanades = $9, preu_unitari = $10,
           pes_fitxa_kg = $11, pes_calculat_kg = $12, pes_editable = $13
         WHERE id = $1`,
        [existent.id, ...valores],
      );
    } else {
      await client.query(
        `INSERT INTO comanda_linia (
           comanda_id, ordinal, woo_line_item_id, producte_id, alias_producte_id,
           woo_product_id, woo_variation_id, woo_sku,
           unitats_demanades, preu_unitari, pes_fitxa_kg, pes_calculat_kg, pes_editable,
           data_produccio
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [comandaId, ...valores, dataProduccioNoves],
      );
    }
  }

  const noUsades = existents.filter((e) => !usades.has(e.id)).map((e) => e.id);
  if (noUsades.length > 0) {
    await client.query(`UPDATE comanda_linia SET esborrat = true WHERE id = ANY($1)`, [noUsades]);
  }

  return { liniesNoResoltes: noResoltes };
}

/**
 * Piso de activación: `null` = sin piso (sólo posible fuera de producción,
 * sin `INGESTA_COMANDES_DES_DE` configurada — comportamiento actual, nadie
 * se queda sin poder sincronizar en desarrollo/test por esto). En
 * producción, la variable es OBLIGATORIA en la práctica aunque `env.ts` no
 * bloquee el arranque si falta (a propósito, ver comentario en env.ts): acá
 * es donde se exige de verdad, en tiempo de ejecución, para que nunca pueda
 * crearse un pedido sin este control activo. Tirar un error (no devolver un
 * resultado "vacío") es deliberado: es un error de configuración, no un
 * resultado válido de negocio — se propaga igual al polling (capturado por
 * fila en `transformarComandes`, cuenta como error) y al webhook (capturado
 * en `procesarEventoWebhook`, queda en `esdeveniment_webhook.error`).
 *
 * Parámetros inyectables con default de `env` (mismo criterio que
 * `autenticarTasca` en `autenticacio-tasques.ts`): permite testear los tres
 * caminos — sin piso, con piso, piso obligatorio y ausente — sin depender
 * de variables de entorno globales del proceso.
 */
function resolverPisoActivacio(
  entorn: string = env.NODE_ENV,
  pisoStr: string | undefined = env.INGESTA_COMANDES_DES_DE,
): Date | null {
  if (pisoStr === undefined) {
    if (entorn === 'production') {
      throw new Error(
        'INGESTA_COMANDES_DES_DE no está configurada en producción — no se puede crear ' +
          'ningún pedido de WooCommerce sin el piso de fecha de activación.',
      );
    }
    return null;
  }
  return new Date(pisoStr);
}

/**
 * true = el pedido es anterior al piso, o su fecha de creación no se pudo
 * determinar con certeza (ninguno de los dos casos es un error: se omite y
 * se loguea, nada más). `piso === null` (sin piso configurado) nunca omite.
 */
function omitidoPorPisoActivacio(wooOrder: WooOrder, piso: Date | null): boolean {
  if (piso === null) return false;

  if (!wooOrder.date_created_gmt) {
    logger.warn(
      { wooOrderId: wooOrder.id },
      'Pedido sin date_created_gmt — no se puede confirmar que sea posterior al piso de activación, se omite',
    );
    return true;
  }

  let dataCreacio: Date;
  try {
    // parsearFechaGmt interpreta la ausencia de "Z" como UTC (ya es lo
    // correcto: date_created_gmt YA está en GMT, ver sync/fechas.ts) — nunca
    // new Date() directo, que lo tomaría como hora local del proceso.
    dataCreacio = parsearFechaGmt(wooOrder.date_created_gmt);
  } catch {
    logger.warn(
      { wooOrderId: wooOrder.id, dateCreatedGmt: wooOrder.date_created_gmt },
      'Pedido con date_created_gmt inválido — no se puede confirmar que sea posterior al piso de activación, se omite',
    );
    return true;
  }

  // Estricto en "anterior" (<), nunca en "igual" — una fecha EXACTAMENTE
  // igual al piso cuenta como incluida (regla de negocio: "a partir de").
  if (dataCreacio.getTime() < piso.getTime()) {
    logger.info(
      { wooOrderId: wooOrder.id, dataCreacio: dataCreacio.toISOString(), piso: piso.toISOString() },
      'Pedido anterior al piso de activación — se omite, nunca entra al sistema',
    );
    return true;
  }

  return false;
}

export async function transformarComanda(
  client: PoolClient,
  wooOrder: WooOrder,
  entornActivacio: string = env.NODE_ENV,
  pisoActivacioStr: string | undefined = env.INGESTA_COMANDES_DES_DE,
): Promise<ResultatComanda> {
  // Piso de activación — lo PRIMERO que se chequea, antes de tomar el lock,
  // de resolver/crear cliente o de tocar la base para nada (tarea del
  // 08/10/2026): un pedido anterior a la fecha de activación no debe dejar
  // ningún rastro, ni siquiera un cliente nuevo a medio resolver.
  const piso = resolverPisoActivacio(entornActivacio, pisoActivacioStr);
  if (omitidoPorPisoActivacio(wooOrder, piso)) {
    return {
      comandaId: null,
      congelada: false,
      actualitzada: false,
      liniesNoResoltes: 0,
      omesaPerPisoActivacio: true,
      liniesProtegides: false,
    };
  }

  // Lock de concurrencia (decisión ya tomada, ver docs/decisiones-arquitectura.md):
  // el webhook (capa de servidor) y el polling por lote pueden llegar a
  // transformar el MISMO pedido casi al mismo tiempo. pg_advisory_xact_lock
  // serializa por woo_order_id — se libera solo al terminar la transacción
  // del llamador (BEGIN/COMMIT/ROLLBACK), nunca hay que liberarlo a mano.
  await client.query('SELECT pg_advisory_xact_lock($1)', [wooOrder.id]);

  const existent = await obtenirComandaExistent(client, wooOrder.id);

  if (existent && existent.congelat_a !== null) {
    await registrarIncidencia(
      client,
      existent.id,
      'actualitzacio_sobre_congelada',
      `WooCommerce mandó una actualización (date_modified_gmt=${wooOrder.date_modified_gmt}) para un pedido congelado desde ${existent.congelat_a.toISOString()}.`,
    );
    logger.warn(
      {
        wooOrderId: wooOrder.id,
        comandaId: existent.id,
        congeladaDesde: existent.congelat_a.toISOString(),
      },
      'Actualización de WooCommerce ignorada: el pedido está congelado — se registró como incidencia',
    );
    return {
      comandaId: existent.id,
      congelada: true,
      actualitzada: false,
      liniesNoResoltes: 0,
      omesaPerPisoActivacio: false,
      liniesProtegides: false,
    };
  }

  // Se resuelve/crea ANTES de la rama de guardián de versión: vincular el
  // cliente no depende de que esta corrida traiga una versión más nueva
  // del pedido (ver vincularClientSiFalta).
  //
  // ADR-023: un conflicto de identidad (ConflicteIdentitatClient) NO puede
  // hacer perder el pedido entero — se captura acá mismo, client_id queda
  // null y sigue el flujo normal (crear/vincular con null, registrar
  // incidencia más abajo). Cualquier otro error sigue propagándose sin
  // capturar, tal como antes.
  let clientId: string | null;
  let conflicteIdentitat: IndexConflicteClient | null = null;
  try {
    clientId = await resolverOCrearClient(client, wooOrder);
  } catch (err) {
    if (!(err instanceof ConflicteIdentitatClient)) throw err;
    clientId = null;
    conflicteIdentitat = err.index;
  }

  // Tarea 39: la data de producció de la CABECERA sólo se calcula al crear
  // la comanda; en actualizaciones posteriores es del sistema (ADR-005) y
  // no se toca (ver crearComanda vs actualitzarCapcaleraSiCorrespon, que no
  // la incluye). Para las LÍNEAS es distinto (ajuste del 08/10/2026,
  // ADR-025): una línea que WooCommerce agrega en una actualización a una
  // comanda ya existente hereda la fecha que la cabecera YA tiene (si la
  // tiene) — antes quedaba siempre en NULL, invisible para Obrador/Producció
  // (que filtran por `comanda_linia.data_produccio`, ver `panells.ts`).
  const dataProduccioNoves = existent
    ? existent.data_produccio
    : calcularDataProduccioWoo(parsearFechaGmt(wooOrder.date_created_gmt));

  let comandaId: string;

  if (!existent) {
    comandaId = await crearComanda(client, wooOrder, clientId, dataProduccioNoves);
  } else {
    comandaId = existent.id;
    await vincularClientSiFalta(client, comandaId, clientId);
  }

  if (conflicteIdentitat !== null) {
    await registrarIncidenciaConflicteIdentitatSiFalta(client, comandaId, conflicteIdentitat);
    logger.warn(
      { wooOrderId: wooOrder.id, comandaId, index: conflicteIdentitat },
      'Conflicto de identidad de cliente al resolver — se registró como incidencia, client_id queda null',
    );
  } else if (clientId === null) {
    await registrarIncidenciaSenseDadesClientSiFalta(client, comandaId);
    logger.warn(
      { wooOrderId: wooOrder.id, comandaId },
      'Pedido sin NIF ni email resoluble — se registró como incidencia',
    );
  }

  if (existent) {
    const actualizada = await actualitzarCapcaleraSiCorrespon(client, comandaId, wooOrder);
    if (!actualizada) {
      logger.info(
        { wooOrderId: wooOrder.id, comandaId },
        'Versión no más nueva que la almacenada — se omite (guardián de versión)',
      );
      return {
        comandaId,
        congelada: false,
        actualitzada: false,
        liniesNoResoltes: 0,
        omesaPerPisoActivacio: false,
        liniesProtegides: false,
      };
    }
  }

  // ADR-026 (08/10/2026): Oficina ya editó una línea de este pedido en algún
  // momento — desde entonces, ninguna sincronización vuelve a tocar sus
  // líneas (ni a actualizarlas/insertarlas, ni a marcar esborrat las que ya
  // no vengan, ni a registrar la incidencia "article_no_resolt"). La
  // cabecera YA se actualizó arriba (`actualitzarCapcaleraSiCorrespon`) con
  // el comportamiento de siempre — sólo las líneas quedan protegidas.
  if (existent?.linies_editades_a != null) {
    logger.info(
      { wooOrderId: wooOrder.id, comandaId },
      'Líneas protegidas: Oficina ya las editó — la sincronización sólo actualizó la cabecera',
    );
    return {
      comandaId,
      congelada: false,
      actualitzada: true,
      liniesNoResoltes: 0,
      omesaPerPisoActivacio: false,
      liniesProtegides: true,
    };
  }

  const { liniesNoResoltes } = await processarLinies(
    client,
    comandaId,
    wooOrder,
    dataProduccioNoves,
  );

  if (liniesNoResoltes > 0) {
    await registrarIncidencia(
      client,
      comandaId,
      'article_no_resolt',
      `${liniesNoResoltes} línea(s) sin artículo resuelto.`,
    );
    logger.warn(
      { wooOrderId: wooOrder.id, comandaId, liniesNoResoltes },
      'Pedido con líneas sin artículo resuelto — se registró como incidencia',
    );
  }

  return {
    comandaId,
    congelada: false,
    actualitzada: true,
    liniesNoResoltes,
    omesaPerPisoActivacio: false,
    liniesProtegides: false,
  };
}

export async function transformarComandes(
  pool: Pool = poolPerDefecte,
  entornActivacio: string = env.NODE_ENV,
  pisoActivacioStr: string | undefined = env.INGESTA_COMANDES_DES_DE,
): Promise<ResultatTransformacioComandes> {
  const crudos = await pool.query<{ woo_id: number; payload: WooOrder }>(
    `SELECT woo_id, payload FROM aterratge_woocommerce WHERE recurs = 'orders' ORDER BY woo_id`,
  );

  const resultat: ResultatTransformacioComandes = {
    comandesProcessades: 0,
    comandesActualitzades: 0,
    comandesCongelades: 0,
    comandesDescartadesPerVersio: 0,
    comandesOmesesPerData: 0,
    comandesLiniesProtegides: 0,
    liniesNoResoltes: 0,
    errors: 0,
  };

  for (const fila of crudos.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await transformarComanda(client, fila.payload, entornActivacio, pisoActivacioStr);
      await client.query('COMMIT');

      resultat.comandesProcessades++;
      if (r.omesaPerPisoActivacio) {
        resultat.comandesOmesesPerData++;
      } else {
        resultat.liniesNoResoltes += r.liniesNoResoltes;
        if (r.congelada) resultat.comandesCongelades++;
        else if (!r.actualitzada) resultat.comandesDescartadesPerVersio++;
        else resultat.comandesActualitzades++;
        // ADR-026: no es mutuamente excluyente con comandesActualitzades —
        // la cabecera sí se actualizó, sólo que además las líneas quedaron
        // protegidas (no es un contador de "qué pasó con la cabecera").
        if (r.liniesProtegides) resultat.comandesLiniesProtegides++;
      }
    } catch (err) {
      await client.query('ROLLBACK');
      resultat.errors++;
      logger.error(
        { wooOrderId: fila.woo_id, error: err instanceof Error ? err.message : String(err) },
        'Falló la transformación de un pedido — se omite y se sigue con el resto',
      );
    } finally {
      client.release();
    }
  }

  logger.info(resultat, 'Transformación de pedidos completada');
  return resultat;
}
