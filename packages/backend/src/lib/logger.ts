import pino from 'pino';
import { env } from '../config/env.js';

/**
 * `redact` es una red de seguridad además de la disciplina de no loggear
 * datos personales: si alguna vez se vuelca por error un objeto con estas
 * claves (nombre, NIF, dirección, cabecera de autenticación...), Pino lo
 * censura en vez de escribirlo tal cual.
 *
 * Exportado aparte (no inline en `pino({...})`) para que logger.test.ts
 * pueda construir una instancia de Pino con esta MISMA config apuntando a
 * un stream propio y verificar la redacción real, sin depender de cómo
 * Pino escribe a stdout internamente (sonic-boom, no `process.stdout.write`).
 */
export const configRedaccio = {
  paths: [
    'req.headers.authorization',
    // El serializer por defecto de Fastify para "req" vuelca la IP del
    // emisor en cada línea de "incoming request" —
    // dato personal bajo RGPD, no sólo credenciales o campos de negocio.
    'req.remoteAddress',
    'req.headers["x-forwarded-for"]',
    '*.email',
    '*.correu',
    '*.telefon',
    '*.telefono',
    '*.nif',
    // ADR-027: el aviso «NIF diferent» lleva los dos NIF.
    '*.nifAnterior',
    '*.nifComanda',
    '*.dni',
    '*.adreca',
    '*.direccion',
    '*.billing',
    '*.shipping',
    // POST /usuaris devuelve un link de un solo uso para
    // establecer contraseña (generatePasswordResetLink) — nunca debe
    // quedar en texto plano en un log. Fastify no loguea el body de la
    // respuesta por defecto (sólo statusCode/responseTime, ver
    // servidor.ts), así que esto es una red de seguridad adicional, no la
    // única barrera — ningún código de la ruta debe pasarle este campo al
    // logger tampoco.
    '*.linkEstabliment',
  ],
  censor: '[redactat]',
};

/** JSON estructurado directo a stdout — Cloud Logging lo entiende sin transports ni escritura a archivo (Cloud Run no tiene disco persistente). */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: configRedaccio,
});
