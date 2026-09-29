import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { env } from '../../../config/env.js';
import { migrarArriba } from '../../../db/migrate.js';
import type { construirServidor as construirServidorType } from '../../servidor.js';

export interface EntornTestApi {
  esquema: string;
  poolTest: Pool;
  construirServidor: typeof construirServidorType;
}

/**
 * Mismo patrón que webhook.test.ts/tasques.test.ts: las rutas usan el pool
 * singleton de db/pool.ts, que sólo abre conexiones físicas de forma
 * perezosa — `PGOPTIONS` fijado ANTES del import dinámico de servidor.ts
 * alcanza para que esas conexiones nazcan con el mismo search_path que usa
 * `poolTest`. Un solo esquema por ARCHIVO de test (no por describe): una
 * vez que el pool abre una conexión, cambiar PGOPTIONS más tarde en el
 * mismo proceso no la afecta.
 */
export async function prepararEntornApi(prefix: string): Promise<EntornTestApi> {
  const esquema = `test_api_${prefix}_${randomUUID().replaceAll('-', '_')}`;
  const setup = new Client({ connectionString: env.DATABASE_URL });
  await setup.connect();
  await setup.query(`CREATE SCHEMA "${esquema}"`);
  await setup.query(`SET search_path TO "${esquema}"`);
  await migrarArriba(setup);
  // origen_comanda no se siembra en la migración (sus filas son datos de
  // arranque, ver seed-arranque.ts) — pero desde la migración 0013,
  // comanda.origen_id es NOT NULL y toda alta de comanda (manual o sync)
  // necesita resolver contra ella. Sin esto, cualquier test que cree
  // una comanda fallaría por falta de las filas mínimas que en un ambiente
  // real ya están cargadas antes de que el sistema reciba tráfico.
  await setup.query(`
    INSERT INTO origen_comanda (codi, nom) VALUES ('woocommerce', 'WooCommerce'), ('manual', 'Manual')
    ON CONFLICT (codi) DO NOTHING
  `);
  await setup.end();

  const poolTest = new Pool({
    connectionString: env.DATABASE_URL,
    options: `-c search_path=${esquema}`,
  });

  process.env.PGOPTIONS = `-c search_path=${esquema}`;
  const { construirServidor } = await import('../../servidor.js');

  return { esquema, poolTest, construirServidor };
}

/**
 * `res.json()` de light-my-request está tipado `any` — asignarlo directo
 * dispara `no-unsafe-assignment`/`no-unsafe-member-access` en cascada. Esta
 * función corta la propagación: la anotación de retorno explícita (`T`) es
 * lo único que ve el llamador, no el `any` de adentro.
 */
export function cuerpoJson<T>(res: { json: () => unknown }): T {
  return res.json() as T;
}

/**
 * Helper compartido: promueve el usuario auto-provisionado de test (uid
 * fijo `dev-sense-auth`, ver `AUTH_DISABLED`) al rol Administrador, para
 * poder ejercer endpoints con guarda de módulo
 * (`usuaris`/`rols`) en los tests. El bypass de desarrollo siempre resuelve
 * al mismo uid — no hay forma de simular un segundo usuario real vía
 * headers — así que "ser Administrador" en un test es literalmente mover
 * el `rol_id` de esa única fila. Dispara el auto-provisioning primero
 * (`GET /jo`) por si todavía no corrió en este esquema.
 */
export async function promoureAAdministrador(
  entorn: EntornTestApi,
  fastify: { inject: (opcions: { method: string; url: string }) => Promise<unknown> },
): Promise<void> {
  await fastify.inject({ method: 'GET', url: '/api/v1/jo' });
  await entorn.poolTest.query(
    `UPDATE usuari SET rol_id = (SELECT id FROM rol WHERE nom = 'Administrador')
     WHERE firebase_uid = 'dev-sense-auth'`,
  );
}

/**
 * Los 6 roles reales de producción (confirmados por Gerardo, hallazgo B1) —
 * ninguno excepto Administrador/General se siembra en las migraciones (esos
 * dos sí, migración 0014): "Oficina"/"Obrador"/"Empaquetat"/"Producció" son
 * configuración viva creada a mano por un Administrador vía RoleFormModal
 * (`POST /rols`), no datos estructurales del sistema — por eso los tests de
 * guard por módulo los siembran acá con sus `modulsPermesos` EXACTOS, en vez
 * de asumir que van a existir ya en cualquier esquema de test.
 */
export const ROLS_REALS = {
  administrador: [
    'categories',
    'catalog',
    'tarifes',
    'tarifes-clients',
    'comandes',
    'rendiments-porcs',
    'panell-oficina',
    'panell-obrador',
    'panell-empaquetat',
    'panell-produccio',
    'usuaris',
    'rols',
    'transportistes',
  ],
  general: [
    'categories',
    'catalog',
    'tarifes',
    'tarifes-clients',
    'comandes',
    'rendiments-porcs',
    'panell-oficina',
    'panell-obrador',
    'panell-empaquetat',
    'panell-produccio',
  ],
  oficina: ['comandes', 'panell-oficina'],
  obrador: ['panell-obrador'],
  empaquetat: ['panell-empaquetat'],
  produccio: [
    'categories',
    'catalog',
    'tarifes',
    'tarifes-clients',
    'comandes',
    'rendiments-porcs',
    'panell-oficina',
    'panell-obrador',
    'panell-empaquetat',
    'panell-produccio',
  ],
} as const satisfies Record<string, readonly string[]>;

export type NomRolReal = keyof typeof ROLS_REALS;

/**
 * Mismo patrón que `promoureAAdministrador`: el bypass de desarrollo
 * (`AUTH_DISABLED`) siempre resuelve al mismo uid fijo (`dev-sense-auth`) —
 * "ser un rol concreto" en un test es upsertear ESE rol con sus
 * `modulsPermesos` reales (`ROLS_REALS`) y mover la única fila de usuari a
 * él. `GET /jo` dispara el auto-provisioning si todavía no corrió en este
 * esquema.
 *
 * 'Administrador'/'General' YA existen sembrados por la migración 0014 —
 * históricamente con un set de módulos desactualizado respecto a la
 * configuración real de producción ('Administrador' sin 'transportistes',
 * agregado después a mano vía RoleFormModal sin tocar la migración de
 * origen). Ya CERRADO por la migración 0020 (idempotente: agrega
 * 'transportistes' sólo si todavía no está), aplicada en cada
 * `prepararEntornApi` porque corre todas las migraciones reales del
 * proyecto — un esquema de test recién migrado ya sale con el
 * 'Administrador' completo de 13 módulos, igual que producción.
 *
 * Por qué el UPDATE explícito de acá abajo sigue existiendo igual (no se
 * simplificó a sólo mover `rol_id`): 0020 resuelve 'Administrador' contra
 * la migración, pero no protege contra que alguien edite el rol real a
 * mano en medio de una corrida de tests (mismo motivo por el que Empaquetat/
 * Obrador/Oficina/Producció, que no viven en ninguna migración, también se
 * fuerzan acá) — forzar `ROLS_REALS` en los 6 casos por igual es más simple
 * de razonar que dos caminos distintos según el rol.
 */
const NOM_ROL_SEMBRAT: Partial<Record<NomRolReal, string>> = {
  administrador: 'Administrador',
  general: 'General',
};

export async function promoureARol(
  entorn: EntornTestApi,
  fastify: { inject: (opcions: { method: string; url: string }) => Promise<unknown> },
  nomRol: NomRolReal,
): Promise<void> {
  await fastify.inject({ method: 'GET', url: '/api/v1/jo' });
  const nomReal = NOM_ROL_SEMBRAT[nomRol] ?? nomRol;
  await entorn.poolTest.query(
    `INSERT INTO rol (nom, moduls_permesos) VALUES ($1, $2)
     ON CONFLICT (nom) DO UPDATE SET moduls_permesos = EXCLUDED.moduls_permesos`,
    [nomReal, ROLS_REALS[nomRol]],
  );
  await entorn.poolTest.query(
    `UPDATE usuari SET rol_id = (SELECT id FROM rol WHERE nom = $1) WHERE firebase_uid = 'dev-sense-auth'`,
    [nomReal],
  );
}

export async function netejarEntornApi(entorn: EntornTestApi): Promise<void> {
  delete process.env.PGOPTIONS;
  await entorn.poolTest.end();
  const cleanup = new Client({ connectionString: env.DATABASE_URL });
  await cleanup.connect();
  await cleanup.query(`DROP SCHEMA IF EXISTS "${entorn.esquema}" CASCADE`);
  await cleanup.end();
}
