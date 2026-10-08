import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { finestraReconciliacio, ingerirCataleg, ingerirComandes } from '../../sync/ingesta.js';
import { transformarCataleg } from '../../transform/cataleg.js';
import { transformarComandes } from '../../transform/comandes.js';
import { autenticarTasca } from '../autenticacio-tasques.js';
import { cosError } from '../error-api.js';

/**
 * true = autenticado, ya escribió la respuesta 401 si no. Un solo chequeo
 * para las tres rutas — en producción valida OIDC de Cloud Scheduler, si
 * no, el secreto compartido (ver autenticacio-tasques.ts).
 */
async function autenticarOResponder(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const ok = await autenticarTasca(req.headers.authorization);
  if (!ok) {
    reply.code(401).send(cosError('NO_AUTENTICAT', 'No autoritzat'));
    return false;
  }
  return true;
}

/**
 * Piso de activación (ajuste del 08/10/2026) — ANTES, con la variable
 * ausente en producción, sync-comandes/reconciliar igual llamaban a la
 * tienda y aterrizaban los pedidos en aterratge_woocommerce; sólo fallaba
 * la transformación, fila por fila (transformarComanda) — y si el lote
 * venía vacío, ese fallo ni se veía. Este chequeo corre ANTES de tocar la
 * tienda para nada: en producción, sin `INGESTA_COMANDES_DES_DE`, ninguna
 * de las dos rutas que ingieren pedidos llega siquiera a `ingerirComandes`.
 *
 * Mismo código/forma de error que usa el `setErrorHandler` global
 * (`http/servidor.ts:74-87`) para cualquier 500 no gestionado por una ruta
 * — `ERROR_INTERN` es justamente el código reservado para errores del
 * servidor (de configuración, en este caso), no del cliente que llama. A
 * diferencia de un `throw` simple (que ese handler global convertiría en un
 * mensaje genérico, "Error intern del servidor", ocultando la causa real),
 * acá se responde el mensaje explícito a propósito — es justo lo que
 * Cloud Scheduler/quien mire la respuesta necesita ver.
 *
 * `entorn`/`pisoStr` inyectables (default de `env`), mismo criterio que
 * `autenticarTasca` — permite testear el camino de producción sin mutar
 * variables de entorno globales del proceso.
 */
export function comprobarPisoActivacioOResponder(
  reply: FastifyReply,
  entorn: string = env.NODE_ENV,
  pisoStr: string | undefined = env.INGESTA_COMANDES_DES_DE,
): boolean {
  if (entorn === 'production' && pisoStr === undefined) {
    reply
      .code(500)
      .send(
        cosError(
          'ERROR_INTERN',
          'INGESTA_COMANDES_DES_DE no está configurada en producción — no se puede sincronizar ' +
            'pedidos de WooCommerce sin el piso de fecha de activación.',
        ),
      );
    return false;
  }
  return true;
}

/**
 * Las tres rutas son idempotentes por construcción, no por lógica nueva
 * acá: ingerirComandes/ingerirCataleg upsertean el aterrizaje y sólo avanzan
 * el cursor si el lote se procesó entero (capa de ingesta); transformarComandes/
 * transformarCataleg aplican el guardián de versión y el upsert por código
 * (capa de transformación). Si Cloud Scheduler reintenta, correr esto de
 * nuevo no duplica nada.
 */
export function registrarRutesTasques(fastify: FastifyInstance): void {
  fastify.post('/tasques/sync-comandes', async (req, reply) => {
    if (!(await autenticarOResponder(req, reply))) return;
    if (!comprobarPisoActivacioOResponder(reply)) return;
    const ingesta = await ingerirComandes(pool);
    const transformacio = await transformarComandes(pool);
    return reply.code(200).send({ ingesta, transformacio });
  });

  fastify.post('/tasques/sync-cataleg', async (req, reply) => {
    if (!(await autenticarOResponder(req, reply))) return;
    const ingesta = await ingerirCataleg(pool);
    const transformacio = await transformarCataleg(pool);
    return reply.code(200).send({ ingesta, transformacio });
  });

  fastify.post('/tasques/reconciliar', async (req, reply) => {
    if (!(await autenticarOResponder(req, reply))) return;
    if (!comprobarPisoActivacioOResponder(reply)) return;
    const modifiedAfterForcat = finestraReconciliacio(7);

    const ingestaComandes = await ingerirComandes(pool, { modifiedAfterForcat });
    const transformacioComandes = await transformarComandes(pool);
    const ingestaCataleg = await ingerirCataleg(pool, { modifiedAfterForcat });
    const transformacioCataleg = await transformarCataleg(pool);

    return reply.code(200).send({
      ingestaComandes,
      transformacioComandes,
      ingestaCataleg,
      transformacioCataleg,
    });
  });
}
