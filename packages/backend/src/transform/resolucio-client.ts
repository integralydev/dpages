import { DatabaseError } from 'pg';
import type { Client, Pool, PoolClient } from 'pg';
import type { WooMetaData, WooOrder } from '@dpages/shared';
import { assignarCodiAutogenerat } from '../db/client-codi.js';
import { CODI_TARIFA_WEB } from './tarifa-web.js';

/** Sólo hace falta `.query()` — acepta Pool, PoolClient o Client suelto (mismo criterio que resolucio-article.ts). */
type Consultable = Pool | PoolClient | Client;

/**
 * Los tres índices únicos reales de `client` (migraciones 0003 y 0009).
 * `nif` nunca puede aparecer como "el otro índice que chocó": si `nif` no
 * es null, siempre es el target de `ON CONFLICT` de este mismo upsert (ver
 * `columnaConflicto` más abajo), así que un choque contra `idx_client_nif`
 * ya lo resuelve Postgres solo, nunca llega a lanzar.
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
  return (
    extraerMetaData(wooOrder.meta_data, 'nif') ??
    extraerMetaData(wooOrder.meta_data, '_billing_myfield5')
  );
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
 * Resuelve el cliente de un pedido — primero por NIF, si no por email
 * (criterio confirmado para esta capa). `null` si no hay ninguno de los
 * dos (en la práctica, casi nunca: el email tiene 100% de cobertura en los
 * pedidos reales).
 *
 * Upsert atómico (`INSERT ... ON CONFLICT`), no "SELECT y después INSERT":
 * dos pedidos del MISMO cliente nuevo pueden procesarse casi al mismo
 * tiempo (webhook + polling) y el lock de concurrencia de
 * `transformarComanda` es por `woo_order_id`, no por cliente — no los
 * serializa entre sí. El upsert nunca pisa un dato que la oficina ya haya
 * cargado a mano vía `PATCH /clients/:id` (`COALESCE(client.columna, ...)`
 * en el `DO UPDATE`, sólo completa huecos).
 */
export async function resolverOCrearClient(
  client: Consultable,
  wooOrder: WooOrder,
): Promise<string | null> {
  const nif = extraerNif(wooOrder);
  const email = extraerEmail(wooOrder);
  if (nif === null && email === null) return null;

  const valores = [
    nif,
    email,
    extraerNom(wooOrder),
    extraerOpcional(wooOrder.billing.phone),
    extraerOpcional(wooOrder.billing.city),
    wooOrder.customer_id > 0 ? wooOrder.customer_id : null,
    wooOrder.customer_id === 0,
    CODI_TARIFA_WEB,
  ];

  // Sólo dos valores posibles, fijados acá mismo — nunca viene de la
  // petición, así que interpolarlo en el SQL no es una inyección.
  const columnaConflicto = nif !== null ? 'nif' : 'email';

  // SAVEPOINT antes del INSERT riesgoso: un unique_violation dentro de una
  // transacción no sólo falla ESA sentencia, deja TODA la transacción en
  // estado "aborted" hasta el próximo ROLLBACK — capturar el error en JS no
  // alcanza para seguir usando la misma conexión. El caller (transformarComanda)
  // sigue escribiendo más filas (comanda, comanda_linia, incidencia_comanda)
  // en la MISMA transacción después de este conflicto, así que hace falta
  // acotar el daño a un SAVEPOINT propio y volver a él, no a toda la
  // transacción entera.
  await client.query('SAVEPOINT resolucio_client');
  try {
    const res = await client.query<{ id: string; id_seq: string }>(
      // Tarea 42: un cliente nuevo de la web nace con la tarifa 01. El
      // `DO UPDATE` no toca `tarifa_id` a propósito: la tarifa de un cliente
      // que ya existía (con otra o sin ninguna) no se cambia.
      `INSERT INTO client (nif, email, nom, telefon, poblacio, woo_customer_id, es_convidat, tarifa_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT id FROM tarifa WHERE codi = $8))
       ON CONFLICT (${columnaConflicto}) WHERE ${columnaConflicto} IS NOT NULL DO UPDATE SET
         nif = COALESCE(client.nif, EXCLUDED.nif),
         email = COALESCE(client.email, EXCLUDED.email),
         nom = COALESCE(client.nom, EXCLUDED.nom),
         telefon = COALESCE(client.telefon, EXCLUDED.telefon),
         poblacio = COALESCE(client.poblacio, EXCLUDED.poblacio),
         woo_customer_id = COALESCE(client.woo_customer_id, EXCLUDED.woo_customer_id)
       RETURNING id, id_seq`,
      valores,
    );
    await client.query('RELEASE SAVEPOINT resolucio_client');

    // Todo cliente recibe un `codi` autogenerado, sin importar el origen
    // (sync o alta manual) — ver assignarCodiAutogenerat. Acá cubre los
    // dos caminos de este upsert sin distinguirlos: un cliente
    // nuevo siempre tiene `codi` null recién insertado; uno existente
    // resuelto por `ON CONFLICT` puede ya tener `codi` y no se toca.
    await assignarCodiAutogenerat(client, res.rows[0]!.id, res.rows[0]!.id_seq);

    return res.rows[0]!.id;
  } catch (err) {
    // 23505 = unique_violation. El índice que chocó nunca es el que declara
    // `ON CONFLICT` (ese lo resuelve Postgres solo) — es SIEMPRE uno de los
    // otros dos, la firma del hallazgo de ADR-020/023: el NIF o el email
    // resuelto para este pedido ya pertenece a otro cliente distinto del
    // que coincide por `columnaConflicto`. Cualquier otro error (columna
    // que no existe, conexión caída, lo que sea) se relanza tal cual —
    // sólo estos tres índices conocidos se tratan como caso de negocio.
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
