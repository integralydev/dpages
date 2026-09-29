import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { leerMigraciones, migrarArriba, obtenerEstado } from './migrate.js';

describe('leerMigraciones', () => {
  it('encuentra las migraciones reales del proyecto, ordenadas', () => {
    const migraciones = leerMigraciones();
    expect(migraciones.map((m) => m.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(migraciones[0]?.archivo).toBe('0001_infraestructura_sincronizacion.up.sql');
    expect(migraciones[19]?.archivo).toBe('0020_administrador_transportistes.up.sql');
    expect(migraciones[20]?.archivo).toBe('0021_estat_cancellada.up.sql');
  });
});

/**
 * Estos tests pegan contra un Postgres real (docker-compose, servicio
 * "postgres-test") en un esquema propio y descartable, para no interferir
 * ni con la base de desarrollo ni con otras corridas de tests.
 */
describe('runner de migraciones (Postgres real, esquema aislado)', () => {
  const esquema = `test_migrate_${randomUUID().replaceAll('-', '_')}`;
  const client = new Client({ connectionString: env.DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${esquema}"`);
    await client.query(`SET search_path TO "${esquema}"`);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`);
    await client.end();
  });

  it('aplica las 21 migraciones reales del proyecto', async () => {
    const { aplicadas } = await migrarArriba(client);
    expect(aplicadas).toEqual([
      '0001_infraestructura_sincronizacion.up.sql',
      '0002_cataleg.up.sql',
      '0003_model_transaccional.up.sql',
      '0004_seguiment_sincronitzacio.up.sql',
      '0005_transformacio_comandes.up.sql',
      '0006_categories_i_confirmacio.up.sql',
      '0007_incidencia_cataleg_i_neteja_producte_fantasma.up.sql',
      '0008_api_negoci.up.sql',
      '0009_resolucio_client.up.sql',
      '0010_camps_prototip_agost.up.sql',
      '0011_cataleg_extens.up.sql',
      '0012_rendiments_i_mantenim.up.sql',
      '0013_correccions_capa15.up.sql',
      '0014_usuaris_i_rols.up.sql',
      '0015_client_codi_unic.up.sql',
      '0016_unitats_decimal.up.sql',
      '0017_treball_obrador.up.sql',
      '0018_rendiments_per_agrupacio.up.sql',
      '0019_data_comanda.up.sql',
      '0020_administrador_transportistes.up.sql',
      '0021_estat_cancellada.up.sql',
    ]);

    const tablas = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [esquema],
    );
    const nombres = tablas.rows.map((r) => r.table_name);
    expect(nombres).toEqual(
      expect.arrayContaining([
        'aterratge_woocommerce',
        'cursor_sincronitzacio',
        'esdeveniment_webhook',
        'producte',
        'alias_producte',
        'client',
        'transportista',
        'tarifa',
        'tarifa_preu',
        'comanda',
        'comanda_linia',
        'incidencia_comanda',
        'categoria_producte',
        'incidencia_cataleg',
        'origen_comanda',
        'rendiments_porcs',
        'rol',
        'usuari',
      ]),
    );
  });

  it('correrlo de nuevo no aplica nada (idempotente)', async () => {
    const { aplicadas } = await migrarArriba(client);
    expect(aplicadas).toEqual([]);
  });

  it('status muestra las 21 migraciones aplicadas y el hash en verde', async () => {
    const estado = await obtenerEstado(client);
    expect(estado).toHaveLength(21);
    expect(estado.every((e) => e.aplicada)).toBe(true);
    expect(estado.every((e) => e.hashCoincide)).toBe(true);
    expect(estado.every((e) => e.aplicadaEn !== null)).toBe(true);
  });

  it('detecta si una migración ya aplicada cambió de contenido en disco', async () => {
    await client.query(`UPDATE esquema_migraciones SET checksum = 'hash-adulterado' WHERE id = 1`);

    await expect(migrarArriba(client)).rejects.toThrow(/0001_infraestructura_sincronizacion/);

    const estado = await obtenerEstado(client);
    const primera = estado.find((e) => e.id === 1);
    expect(primera?.hashCoincide).toBe(false);

    // Se deja como estaba para no romper los tests que corren después.
    const [migracionUno] = leerMigraciones();
    await client.query(`UPDATE esquema_migraciones SET checksum = $1 WHERE id = 1`, [
      migracionUno?.checksum,
    ]);
  });
});

describe('runner de migraciones — una falla no revierte las anteriores', () => {
  let dirTemporal: string;
  const esquema = `test_migrate_fail_${randomUUID().replaceAll('-', '_')}`;
  const client = new Client({ connectionString: env.DATABASE_URL });

  beforeAll(async () => {
    dirTemporal = mkdtempSync(path.join(tmpdir(), 'dpages-migraciones-'));
    writeFileSync(
      path.join(dirTemporal, '0001_ok.up.sql'),
      'CREATE TABLE prueba_ok (id INTEGER PRIMARY KEY);',
    );
    writeFileSync(
      path.join(dirTemporal, '0002_rota.up.sql'),
      'CREATE TABLE prueba_rota (id INTEGER REFERENCES tabla_que_no_existe (id));',
    );

    await client.connect();
    await client.query(`CREATE SCHEMA "${esquema}"`);
    await client.query(`SET search_path TO "${esquema}"`);
  });

  afterAll(async () => {
    rmSync(dirTemporal, { recursive: true, force: true });
    await client.query(`DROP SCHEMA IF EXISTS "${esquema}" CASCADE`);
    await client.end();
  });

  it('la 0001 queda aplicada y registrada aunque la 0002 falle', async () => {
    await expect(migrarArriba(client, dirTemporal)).rejects.toThrow(/0002_rota/);

    const tablas = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [esquema],
    );
    const nombres = tablas.rows.map((r) => r.table_name);
    expect(nombres).toContain('prueba_ok');
    expect(nombres).not.toContain('prueba_rota');

    const estado = await obtenerEstado(client, dirTemporal);
    expect(estado.find((e) => e.archivo === '0001_ok.up.sql')?.aplicada).toBe(true);
    expect(estado.find((e) => e.archivo === '0002_rota.up.sql')?.aplicada).toBe(false);
  });

  it('reintentarlo aplica sólo la que faltaba, sin reaplicar la 0001', async () => {
    writeFileSync(
      path.join(dirTemporal, '0002_rota.up.sql'),
      'CREATE TABLE prueba_arreglada (id INTEGER PRIMARY KEY);',
    );

    const { aplicadas } = await migrarArriba(client, dirTemporal);
    expect(aplicadas).toEqual(['0002_rota.up.sql']);
  });
});
