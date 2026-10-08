import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { transformarComanda } from '../../transform/comandes.js';
import { obtenerPedido } from '../../woocommerce/cliente.js';
import { cosError } from '../error-api.js';
import { firmaValida } from '../hmac.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Cuerpo crudo capturado por el content-type parser (ver servidor.ts) — la firma se valida sobre ESTO, nunca sobre el JSON reparseado. */
    rawBody?: Buffer;
  }
}

interface CosWebhookMinim {
  id?: unknown;
}

async function registrarEsdeveniment(
  wooOrderId: number | null,
  topic: string,
  signaturaValida: boolean,
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO esdeveniment_webhook (woo_order_id, topic, signatura_valida)
     VALUES ($1, $2, $3) RETURNING id`,
    [wooOrderId, topic, signaturaValida],
  );
  return res.rows[0]!.id;
}

async function marcarEsdevenimentProcessat(id: number, error: string | null): Promise<void> {
  await pool.query(
    `UPDATE esdeveniment_webhook SET processat = true, processat_en = now(), error = $2 WHERE id = $1`,
    [id, error?.slice(0, 2000) ?? null],
  );
}

/**
 * El trabajo pesado, después de responder (punto 3): el webhook es una
 * notificación, no el dato (punto 1) — se pide el estado canónico y se
 * transforma con la MISMA lógica que usa el polling (guardián de versión,
 * propiedad de columnas, regla de congelación, lock de concurrencia —
 * ninguna de esas reglas es distinta acá).
 */
export async function procesarEventoWebhook(
  wooOrderId: number,
  idEsdeveniment: number,
  // Inyectables (default de env), mismo criterio que transformarComanda —
  // permiten testear el piso de activación acá sin depender de variables
  // de entorno globales del proceso.
  entornActivacio: string = env.NODE_ENV,
  pisoActivacioStr: string | undefined = env.INGESTA_COMANDES_DES_DE,
): Promise<void> {
  try {
    const pedido = await obtenerPedido(wooOrderId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await transformarComanda(client, pedido, entornActivacio, pisoActivacioStr);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await marcarEsdevenimentProcessat(idEsdeveniment, null);
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    await marcarEsdevenimentProcessat(idEsdeveniment, mensaje);
    logger.error(
      { wooOrderId, error: mensaje },
      'Falló el procesamiento en segundo plano del webhook',
    );
  }
}

export function registrarRutaWebhook(fastify: FastifyInstance): void {
  fastify.post('/webhooks/woocommerce', async (req: FastifyRequest, reply) => {
    const cosBrut = req.rawBody ?? Buffer.alloc(0);
    const firmaHeader = req.headers['x-wc-webhook-signature'];
    const firma = typeof firmaHeader === 'string' ? firmaHeader : undefined;

    if (!firmaValida(cosBrut, firma, env.WEBHOOK_SECRET)) {
      // 401 sin explicar por qué: ni "falta la cabecera" ni "no coincide" —
      // un solo mensaje genérico, para no ayudar a nadie a adivinar.
      logger.warn('Webhook de WooCommerce con firma inválida — rechazado');
      return reply.code(401).send(cosError('NO_AUTENTICAT', 'No autoritzat'));
    }

    const topicHeader = req.headers['x-wc-webhook-topic'];
    const topic = typeof topicHeader === 'string' ? topicHeader : 'desconegut';
    const cos = req.body as CosWebhookMinim;
    const wooOrderId = typeof cos.id === 'number' ? cos.id : null;

    const idEsdeveniment = await registrarEsdeveniment(wooOrderId, topic, true);

    // Responder YA (punto 3): Cloud Run puede tardar en arrancar en frío, y
    // WooCommerce desactiva el webhook tras fallos/timeouts repetidos. El
    // trabajo pesado no bloquea la respuesta.
    reply.code(200).send({ ok: true });

    if (wooOrderId !== null) {
      procesarEventoWebhook(wooOrderId, idEsdeveniment).catch((err: unknown) => {
        logger.error(
          { wooOrderId, err },
          'Error inesperado disparando el procesamiento del webhook',
        );
      });
    } else {
      await marcarEsdevenimentProcessat(idEsdeveniment, 'Cuerpo sin id de pedido utilizable');
    }
  });
}
