import { DatabaseError } from 'pg';
import type { Client, Pool, PoolClient } from 'pg';
import type { WooMetaData, WooOrder } from '@dpages/shared';
import { assignarCodiAutogenerat } from '../db/client-codi.js';
import { CODI_TARIFA_WEB } from './tarifa-web.js';

/** Sólo hace falta `.query()` — acepta Pool, PoolClient o Client suelto (mismo criterio que resolucio-article.ts). */
type Consultable = Pool | PoolClient | Client;

/**
 * Los tres índices únicos reales de `client` (migraciones 0003 y 0009).
 * Desde el 25/11/2026 casi nunca chocan: antes de escribir se busca el
 * cliente por email y por NIF, y no se escribe un NIF ni un
 * woo_customer_id que ya tenga otro cliente. Quedan las carreras entre dos
 * pedidos procesados a la vez y el `woo_customer_id` de un cliente nuevo.
 */
const INDEXS_UNICS_CLIENT: Record<string, 'nif' | 'email' | 'woo_customer_id'> = {
  idx_client_nif: 'nif',
  idx_client_email: 'email',
  idx_client_woo_customer_id: 'woo_customer_id',
};

export type IndexConflicteClient = (typeof INDEXS_UNICS_CLIENT)[string];

/**
 * ADR-023: el dato de identidad (NIF/email/woo_customer_id) del mismo
 * cliente varía entre sus propios pedidos (hallazgo de ADR-020) — el
 * upsert de abajo puede chocar contra un índice único DISTINTO del que usó
 * como target de `ON CONFLICT`. No es un error inesperado del sistema, es
 * un caso de negocio conocido y con proporción estable (~10% de los
 * pedidos reales): quien llama (`transformarComanda`) lo captura para
 * registrar una incidencia en vez de perder el pedido entero.
 */
export class ConflicteIdentitatClient extends Error {
  constructor(public readonly index: IndexConflicteClient) {
    super(
      `Conflicto de identidad de cliente: el índice "${index}" ya pertenece a otro cliente registrado.`,
    );
    this.name = 'ConflicteIdentitatClient';
  }
}

function extraerMetaData(metaData: WooMetaData[], clau: string): string | null {
  const entrada = metaData.find((m) => m.key === clau);
  if (entrada === undefined || typeof entrada.value !== 'string') return null;
  const valor = entrada.value.trim();
  return valor === '' ? null : valor;
}

/**
 * El NIF llega en `meta_data` bajo DOS claves que representan lo mismo
 * (docs/hallazgos-woocommerce.md, verificado también contra los 4.250
 * pedidos reales): `nif` (2.331 casos con valor) y `_billing_myfield5`
 * (812 casos con valor — la clave está presente en casi todos los
 * pedidos, pero vacía la mayoría de las veces). De los 419 pedidos donde
 * ambas vienen con valor, 85 difieren entre sí. Se prioriza `nif` por
 * tener un nombre explícito — es una heurística, no una regla confirmada
 * por el cliente (mismo criterio que `inferirIdiomaHeuristic` en
 * `transform/idioma.ts`: documentada, no silenciosa).
 */
function extraerNif(wooOrder: WooOrder): string | null {
  const nif =
    extraerMetaData(wooOrder.meta_data, 'nif') ??
    extraerMetaData(wooOrder.meta_data, '_billing_myfield5');
  // Un "NIF" sin ninguna letra ni cifra ("-", ".") no identifica a nadie.
  return nif !== null && /[A-Za-z0-9]/.test(nif) ? nif : null;
}

/**
 * Forma normalizada del NIF para COMPARAR (nunca para guardar: se guarda
 * tal cual llegó): mayúsculas y sólo letras y cifras. Así `B-43.123.456`,
 * `b43123456` y `B 43123456` son el mismo cliente (incidencia de las
 * comandas web sin cliente, 23/11/2026).
 */
const NIF_NORMALITZAT = (expressio: string): string =>
  `upper(regexp_replace(${expressio}, '[^A-Za-z0-9]', '', 'g'))`;

/** Misma normalización que `NIF_NORMALITZAT`, del lado de JavaScript. */
const normalitzarNif = (nif: string): string => nif.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/**
 * Aviso de «NIF diferent» (decisión del cliente, 25/11/2026): el pedido se
 * asignó al cliente de su email, pero trae otro NIF. Se registra como
 * incidencia para que oficina lo revise.
 */
export interface AvisNifDiferent {
  /** NIF que tenía el cliente antes de este pedido (`null` si no tenía). */
  nifAnterior: string | null;
  nifComanda: string;
  /**
   * El NIF del pedido ya es de OTRO cliente (no puede repetirse): el
   * cliente conserva el anterior. `null` = el cliente pasó a tener el NIF
   * del pedido. Si es de otro cliente sin codi, cadena vacía.
   */
  codiAltreClient: string | null;
}

export interface ResolucioClient {
  clientId: string | null;
  avisNif: AvisNifDiferent | null;
}

export interface OpcionsResolucioClient {
  /**
   * `true` sólo cuando el pedido se vincula ahora a un cliente por primera
   * vez (pedido nuevo o todavía sin cliente). Cada ciclo del sync vuelve a
   * transformar todos los pedidos aterrizados: si los ya vinculados
   * también cambiaran el NIF, el del cliente iría saltando entre los NIF de
   * sus pedidos viejos y cada ciclo generaría avisos.
   */
  permetreCanviNif: boolean;
}

interface FilaClientTrobat {
  id: string;
  nif: string | null;
}

async function cercarPerEmail(
  client: Consultable,
  email: string,
): Promise<FilaClientTrobat | null> {
  // FOR UPDATE: dos pedidos del mismo email procesados a la vez (el lock de
  // `transformarComanda` es por pedido, no por cliente) se serializan acá.
  const res = await client.query<FilaClientTrobat>(
    `SELECT id, nif FROM client WHERE lower(email) = $1 ORDER BY id_seq LIMIT 1 FOR UPDATE`,
    [email],
  );
  return res.rows[0] ?? null;
}

async function cercarPerNif(client: Consultable, nif: string): Promise<FilaClientTrobat | null> {
  const res = await client.query<FilaClientTrobat>(
    `SELECT id, nif FROM client
     WHERE nif IS NOT NULL AND ${NIF_NORMALITZAT('nif')} = ${NIF_NORMALITZAT('$1')}
     ORDER BY (nif = $1) DESC, id_seq
     LIMIT 1
     FOR UPDATE`,
    [nif],
  );
  return res.rows[0] ?? null;
}

/** Otro cliente (no `excepteId`) que ya tiene este NIF, comparado normalizado. */
async function altreClientAmbNif(
  client: Consultable,
  nif: string,
  excepteId: string,
): Promise<{ codi: string | null } | null> {
  const res = await client.query<{ codi: string | null }>(
    `SELECT codi FROM client
     WHERE id <> $2 AND nif IS NOT NULL AND ${NIF_NORMALITZAT('nif')} = ${NIF_NORMALITZAT('$1')}
     ORDER BY id_seq
     LIMIT 1`,
    [nif, excepteId],
  );
  return res.rows[0] ?? null;
}

function extraerEmail(wooOrder: WooOrder): string | null {
  const email = wooOrder.billing.email.trim().toLowerCase();
  return email === '' ? null : email;
}

function extraerNom(wooOrder: WooOrder): string | null {
  const nom = `${wooOrder.billing.first_name} ${wooOrder.billing.last_name}`.trim();
  return nom === '' ? null : nom;
}

function extraerOpcional(valor: string | undefined): string | null {
  const limpio = valor?.trim();
  return limpio ? limpio : null;
}

/**
 * Resuelve el cliente de un pedido de la web. Criterio confirmado por el
 * cliente el 25/11/2026 (reemplaza el supuesto «NIF primero» de ADR-020,
 * ver ADR-027): **manda el email**.
 *
 * 1. Si el email ya es de un cliente (sin distinguir mayúsculas), es ése.
 *    Si el pedido trae otro NIF y `permetreCanviNif`, el cliente se queda
 *    con el NIF del pedido (decisión del cliente) y se devuelve un
 *    `avisNif` — salvo que ese NIF ya sea de otro cliente: entonces
 *    conserva el suyo y el aviso lo dice. Si no tenía NIF, se le completa
 *    sin aviso.
 * 2. Si el email no es de nadie, por NIF normalizado (`B-43.123.456` =
 *    `b43123456`).
 * 3. Si tampoco, se crea (upsert, para la carrera de dos pedidos del mismo
 *    cliente nuevo procesados a la vez).
 *
 * Fuera del NIF del punto 1, nunca pisa un dato ya cargado (sólo completa
 * huecos). `clientId` es `null` si el pedido no trae ni NIF ni email.
 * Puede lanzar `ConflicteIdentitatClient` (ver `INDEXS_UNICS_CLIENT`).
 */
export async function resolverClientComanda(
  client: Consultable,
  wooOrder: WooOrder,
  opcions: OpcionsResolucioClient,
): Promise<ResolucioClient> {
  const nif = extraerNif(wooOrder);
  const email = extraerEmail(wooOrder);
  if (nif === null && email === null) return { clientId: null, avisNif: null };

  const nom = extraerNom(wooOrder);
  const telefon = extraerOpcional(wooOrder.billing.phone);
  const poblacio = extraerOpcional(wooOrder.billing.city);
  const wooCustomerId = wooOrder.customer_id > 0 ? wooOrder.customer_id : null;

  // SAVEPOINT: un unique_violation deja TODA la transacción en estado
  // "aborted" hasta el próximo ROLLBACK, y quien llama
  // (transformarComanda) sigue escribiendo en la misma transacción después
  // de un conflicto — hay que acotar el daño a este SAVEPOINT (ADR-023).
  await client.query('SAVEPOINT resolucio_client');
  try {
    let avisNif: AvisNifDiferent | null = null;
    // NIF que se escribe en el cliente encontrado; `null` = no se toca.
    let nifNou: string | null = null;

    let trobat = email !== null ? await cercarPerEmail(client, email) : null;
    if (trobat !== null) {
      const nifActual = trobat.nif;
      const nifCanvia =
        nif !== null && (nifActual === null || normalitzarNif(nifActual) !== normalitzarNif(nif));
      if (nif !== null && nifCanvia && (nifActual === null || opcions.permetreCanviNif)) {
        const altre = await altreClientAmbNif(client, nif, trobat.id);
        if (altre === null) {
          nifNou = nif;
          if (nifActual !== null) {
            avisNif = { nifAnterior: nifActual, nifComanda: nif, codiAltreClient: null };
          }
        } else if (opcions.permetreCanviNif) {
          avisNif = { nifAnterior: nifActual, nifComanda: nif, codiAltreClient: altre.codi ?? '' };
        }
      }
    } else if (nif !== null) {
      trobat = await cercarPerNif(client, nif);
    }

    const res =
      trobat !== null
        ? await client.query<{ id: string; id_seq: string; existia?: boolean }>(
            // El email sólo se completa si faltaba: por el camino del NIF
            // ningún cliente tiene ya ese email (punto 1). El
            // woo_customer_id, sólo si no es de otro cliente.
            `UPDATE client SET
               nif = COALESCE($2, nif),
               email = COALESCE(email, $3),
               nom = COALESCE(nom, $4),
               telefon = COALESCE(telefon, $5),
               poblacio = COALESCE(poblacio, $6),
               woo_customer_id = COALESCE(
                 woo_customer_id,
                 CASE WHEN NOT EXISTS (SELECT 1 FROM client altre WHERE altre.woo_customer_id = $7)
                   THEN $7::bigint END
               )
             WHERE id = $1
             RETURNING id, id_seq`,
            [trobat.id, nifNou, email, nom, telefon, poblacio, wooCustomerId],
          )
        : await client.query<{ id: string; id_seq: string; existia: boolean }>(
            // Tarea 42: un cliente nuevo de la web nace con la tarifa 01.
            // `columnaConflicto` sólo puede ser uno de estos dos literales
            // fijados acá — interpolarlo no es una inyección.
            `INSERT INTO client (nif, email, nom, telefon, poblacio, woo_customer_id, es_convidat, tarifa_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT id FROM tarifa WHERE codi = $8))
             ON CONFLICT (${email !== null ? 'email' : 'nif'})
               WHERE ${email !== null ? 'email' : 'nif'} IS NOT NULL
             DO UPDATE SET
               nif = COALESCE(client.nif, EXCLUDED.nif),
               email = COALESCE(client.email, EXCLUDED.email),
               nom = COALESCE(client.nom, EXCLUDED.nom),
               telefon = COALESCE(client.telefon, EXCLUDED.telefon),
               poblacio = COALESCE(client.poblacio, EXCLUDED.poblacio),
               woo_customer_id = COALESCE(client.woo_customer_id, EXCLUDED.woo_customer_id)
             RETURNING id, id_seq, (xmax <> 0) AS existia`,
            [
              nif,
              email,
              nom,
              telefon,
              poblacio,
              wooCustomerId,
              wooOrder.customer_id === 0,
              CODI_TARIFA_WEB,
            ],
          );
    const fila = res.rows[0];
    if (fila === undefined) {
      // Sólo el UPDATE puede no devolver fila: el cliente se borró entre
      // la búsqueda y el UPDATE.
      await client.query('ROLLBACK TO SAVEPOINT resolucio_client');
      throw new Error('El client trobat ha desaparegut abans de vincular-lo');
    }
    await client.query('RELEASE SAVEPOINT resolucio_client');

    // Carrera: otro pedido del mismo email nuevo creó el cliente entre la
    // búsqueda y el INSERT (sin fila, el FOR UPDATE no bloqueó nada) y el
    // `DO UPDATE` sólo completó huecos. Se repite la resolución, que ahora
    // lo encuentra por email y aplica el criterio de ADR-027 (NIF y aviso).
    if (fila.existia === true && email !== null) {
      return resolverClientComanda(client, wooOrder, opcions);
    }

    // Todo cliente recibe un `codi` autogenerado (ver
    // assignarCodiAutogenerat); uno que ya lo tenía no se toca.
    await assignarCodiAutogenerat(client, fila.id, fila.id_seq);

    return { clientId: fila.id, avisNif };
  } catch (err) {
    // 23505 = unique_violation contra uno de los tres índices conocidos:
    // caso de negocio (ADR-023), no error del sistema. Cualquier otro error
    // se relanza tal cual.
    if (err instanceof DatabaseError && err.code === '23505' && err.constraint !== undefined) {
      const index = INDEXS_UNICS_CLIENT[err.constraint];
      if (index !== undefined) {
        await client.query('ROLLBACK TO SAVEPOINT resolucio_client');
        throw new ConflicteIdentitatClient(index);
      }
    }
    throw err;
  }
}

/** Atajo de `resolverClientComanda` que sólo devuelve el id (pedido nuevo). */
export async function resolverOCrearClient(
  client: Consultable,
  wooOrder: WooOrder,
): Promise<string | null> {
  return (await resolverClientComanda(client, wooOrder, { permetreCanviNif: true })).clientId;
}
