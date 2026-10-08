import type { Pool, PoolClient } from 'pg';
import type { WooOrder, WooProduct } from '@dpages/shared';
import { env } from '../config/env.js';
import { pool as poolPerDefecte } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { listarPedidos, listarProductos } from '../woocommerce/cliente.js';
import { calcularFinestraConsulta, calcularNouCursor } from './cursor.js';
import { formatearFechaGmt } from './fechas.js';

export interface ResultatIngesta {
  recurs: string;
  esCarregaCompleta: boolean;
  itemsProcessats: number;
  cursorNou: string | null;
}

export interface OpcionsIngesta {
  /**
   * Ignora el cursor guardado y usa esta fecha como modified_after — para
   * la reconciliación (ADR-009: ventana amplia de 7 días). El cursor SÍ se
   * actualiza al final como en cualquier corrida exitosa; una ventana más
   * amplia sólo trae de vuelta registros que ya se habían visto, así que no
   * hay riesgo de que el cursor retroceda.
   */
  modifiedAfterForcat?: string;
}

/** Ventana de reconciliación: N días atrás desde ahora, en el mismo formato que usa WooCommerce. */
export function finestraReconciliacio(diesEnrere = 7): string {
  return formatearFechaGmt(new Date(Date.now() - diesEnrere * 24 * 60 * 60 * 1000));
}

interface ConfigIngesta<T> {
  /** Identifica el recurso tanto en cursor_sincronitzacio como en aterratge_woocommerce.recurs. */
  recurs: string;
  obtenirLot: (modifiedAfter: string | undefined) => Promise<T[]>;
  idDe: (item: T) => number;
  dataModificacioGmtDe: (item: T) => string;
}

async function obtenirCursor(pool: Pool, recurs: string): Promise<Date | null> {
  const res = await pool.query<{ cursor_en: Date | null }>(
    'SELECT cursor_en FROM cursor_sincronitzacio WHERE recurs = $1',
    [recurs],
  );
  return res.rows[0]?.cursor_en ?? null;
}

/** Se corre dentro de la MISMA transacción que el aterrizaje: si una falla, la otra tampoco queda. */
async function registrarExit(
  client: PoolClient,
  recurs: string,
  cursorNou: Date | null,
): Promise<void> {
  await client.query(
    `INSERT INTO cursor_sincronitzacio (recurs, cursor_en, actualitzat_en, ultim_error, ultim_error_en, intents_fallits_consecutius)
     VALUES ($1, $2, now(), NULL, NULL, 0)
     ON CONFLICT (recurs) DO UPDATE SET
       cursor_en = EXCLUDED.cursor_en,
       actualitzat_en = now(),
       ultim_error = NULL,
       ultim_error_en = NULL,
       intents_fallits_consecutius = 0`,
    [recurs, cursorNou],
  );
}

/**
 * Se corre FUERA de la transacción del lote (que ya se revirtió): una
 * conexión propia del pool, para que el fallo quede registrado aunque el
 * aterrizaje se haya revertido entero. El cursor_en existente (si lo hay)
 * nunca se toca acá — sólo lo actualiza registrarExit.
 */
async function registrarFallo(pool: Pool, recurs: string, mensaje: string): Promise<void> {
  await pool.query(
    `INSERT INTO cursor_sincronitzacio (recurs, cursor_en, actualitzat_en, ultim_error, ultim_error_en, intents_fallits_consecutius)
     VALUES ($1, NULL, now(), $2, now(), 1)
     ON CONFLICT (recurs) DO UPDATE SET
       ultim_error = EXCLUDED.ultim_error,
       ultim_error_en = now(),
       intents_fallits_consecutius = cursor_sincronitzacio.intents_fallits_consecutius + 1`,
    [recurs, mensaje.slice(0, 2000)],
  );
}

async function ingerirRecurs<T>(
  config: ConfigIngesta<T>,
  pool: Pool,
  opcions: OpcionsIngesta = {},
): Promise<ResultatIngesta> {
  const cursorPrevi = await obtenirCursor(pool, config.recurs);
  const finestra =
    opcions.modifiedAfterForcat !== undefined
      ? {
          esPrimeraCarrega: false as const,
          esCarregaCompleta: false as const,
          modifiedAfter: opcions.modifiedAfterForcat,
        }
      : calcularFinestraConsulta(
          cursorPrevi,
          undefined,
          env.INGESTA_HISTORIC_COMPLET ? null : env.INGESTA_DIES_ENRERE_DEFECTE,
        );

  if (opcions.modifiedAfterForcat !== undefined) {
    logger.info(
      { recurs: config.recurs, modifiedAfter: finestra.modifiedAfter },
      'Reconciliación: ventana forzada, se ignora el cursor guardado',
    );
  } else if (finestra.esPrimeraCarrega && finestra.esCarregaCompleta) {
    logger.info(
      { recurs: config.recurs },
      'Sin cursor previo — carga del histórico completo (INGESTA_HISTORIC_COMPLET activo, no es el comportamiento por defecto)',
    );
  } else if (finestra.esPrimeraCarrega) {
    logger.info(
      {
        recurs: config.recurs,
        modifiedAfter: finestra.modifiedAfter,
        diesEnrere: env.INGESTA_DIES_ENRERE_DEFECTE,
      },
      `Sin cursor previo — carga inicial acotada a los últimos ${env.INGESTA_DIES_ENRERE_DEFECTE} días (no es el histórico completo)`,
    );
  } else {
    logger.info(
      { recurs: config.recurs, modifiedAfter: finestra.modifiedAfter },
      'Ingesta incremental',
    );
  }

  // Si esto falla (incluida la posibilidad de que reintentos internos del
  // cliente de WooCommerce se agoten a mitad de la paginación), no se llega
  // a tocar ni el aterrizaje ni el cursor: el cursor NO avanza.
  let items: T[];
  try {
    items = await config.obtenirLot(finestra.modifiedAfter);
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    await registrarFallo(pool, config.recurs, mensaje);
    logger.error(
      { recurs: config.recurs, error: mensaje },
      'La ingesta falló al traer el lote — el cursor no avanza',
    );
    throw err;
  }

  // Lote vacío: no hay una fecha nueva de la cual partir. Se conserva el
  // cursor anterior tal cual (nunca se inventa uno ni se retrocede).
  const cursorNou = calcularNouCursor(items.map(config.dataModificacioGmtDe)) ?? cursorPrevi;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      // ON CONFLICT hace que aterrizar el mismo item dos veces nunca
      // duplique fila — ingerir el mismo lote de nuevo es idempotente.
      await client.query(
        `INSERT INTO aterratge_woocommerce (recurs, woo_id, payload, capturat_en)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (recurs, woo_id) DO UPDATE SET payload = EXCLUDED.payload, capturat_en = now()`,
        [config.recurs, config.idDe(item), JSON.stringify(item)],
      );
    }
    await registrarExit(client, config.recurs, cursorNou);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    const mensaje = err instanceof Error ? err.message : String(err);
    await registrarFallo(pool, config.recurs, mensaje);
    logger.error(
      { recurs: config.recurs, error: mensaje },
      'Falló el aterrizaje del lote — se revirtió entero, el cursor no avanza',
    );
    throw err;
  } finally {
    client.release();
  }

  // Cantidad, nunca contenido (RGPD) — igual que en el cliente de WooCommerce.
  logger.info({ recurs: config.recurs, itemsProcessats: items.length }, 'Ingesta completada');

  return {
    recurs: config.recurs,
    esCarregaCompleta: finestra.esCarregaCompleta,
    itemsProcessats: items.length,
    cursorNou: cursorNou ? formatearFechaGmt(cursorNou) : null,
  };
}

/**
 * `pisoActivacioStr` inyectable (default `env.INGESTA_COMANDES_DES_DE`,
 * mismo criterio que `autenticarTasca` en `autenticacio-tasques.ts`): sólo
 * reduce lo que se le pide a WooCommerce (`after`, ver `cliente.ts`) — la
 * barrera real contra pedidos anteriores al piso vive en
 * `transformarComanda`, que vuelve a comparar `date_created_gmt` antes de
 * crear nada, sin confiar en que WooCommerce filtró bien.
 */
export async function ingerirComandes(
  pool: Pool = poolPerDefecte,
  opcions?: OpcionsIngesta,
  pisoActivacioStr: string | undefined = env.INGESTA_COMANDES_DES_DE,
): Promise<ResultatIngesta> {
  return ingerirRecurs<WooOrder>(
    {
      recurs: 'orders',
      obtenirLot: (modifiedAfter) =>
        listarPedidos({ modifiedAfter, createdAfter: pisoActivacioStr }),
      idDe: (pedido) => pedido.id,
      dataModificacioGmtDe: (pedido) => pedido.date_modified_gmt,
    },
    pool,
    opcions,
  );
}

export async function ingerirCataleg(
  pool: Pool = poolPerDefecte,
  opcions?: OpcionsIngesta,
): Promise<ResultatIngesta> {
  return ingerirRecurs<WooProduct>(
    {
      recurs: 'products',
      obtenirLot: (modifiedAfter) => listarProductos({ modifiedAfter }),
      idDe: (producte) => producte.id,
      dataModificacioGmtDe: (producte) => producte.date_modified_gmt,
    },
    pool,
    opcions,
  );
}
