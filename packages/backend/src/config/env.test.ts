import { describe, expect, it } from 'vitest';
import { ErrorConfiguracion, parsearEnv } from './env.js';

const entornoValido = {
  DATABASE_URL: 'postgres://dpages:dpages@localhost:5433/dpages',
  WC_BASE_URL: 'https://woocommerce-test.invalid',
  WC_CONSUMER_KEY: 'ck_test',
  WC_CONSUMER_SECRET: 'cs_test',
  WEBHOOK_SECRET: 'wh_test',
  TASQUES_SECRET: 'tasques_test',
};

describe('parsearEnv', () => {
  it('acepta una configuración mínima y aplica los defaults', () => {
    const env = parsearEnv(entornoValido);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DB_POOL_MAX).toBe(5);
  });

  it('acepta la forma de Cloud SQL de DATABASE_URL (socket unix, sin host)', () => {
    const env = parsearEnv({
      ...entornoValido,
      DATABASE_URL: 'postgresql://dpages:secret@/dpages?host=/cloudsql/proj:region:instance',
    });

    expect(env.DATABASE_URL).toContain('/cloudsql/');
  });

  it('coacciona PORT y DB_POOL_MAX desde string a número', () => {
    const env = parsearEnv({ ...entornoValido, PORT: '3000', DB_POOL_MAX: '3' });

    expect(env.PORT).toBe(3000);
    expect(env.DB_POOL_MAX).toBe(3);
  });

  it('falla si falta DATABASE_URL, y el mensaje dice qué variable falta', () => {
    const { DATABASE_URL: _omitida, ...sinDatabaseUrl } = entornoValido;
    expect(() => parsearEnv(sinDatabaseUrl)).toThrow(ErrorConfiguracion);
    expect(() => parsearEnv(sinDatabaseUrl)).toThrow(/DATABASE_URL/);
  });

  it('falla si DATABASE_URL no tiene forma de cadena de conexión de Postgres', () => {
    expect(() =>
      parsearEnv({ ...entornoValido, DATABASE_URL: 'no-es-una-url-de-postgres' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('falla si NODE_ENV trae un valor fuera de la lista permitida', () => {
    expect(() => parsearEnv({ ...entornoValido, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('falla si falta alguna variable de WooCommerce', () => {
    const { WC_CONSUMER_KEY: _omitida, ...sinConsumerKey } = entornoValido;
    expect(() => parsearEnv(sinConsumerKey)).toThrow(/WC_CONSUMER_KEY/);
  });

  it('falla si WC_BASE_URL no es una URL válida', () => {
    expect(() => parsearEnv({ ...entornoValido, WC_BASE_URL: 'dpages.cat' })).toThrow(
      /WC_BASE_URL/,
    );
  });

  it('falla si falta WEBHOOK_SECRET o TASQUES_SECRET', () => {
    const { WEBHOOK_SECRET: _a, ...sinWebhookSecret } = entornoValido;
    expect(() => parsearEnv(sinWebhookSecret)).toThrow(/WEBHOOK_SECRET/);

    const { TASQUES_SECRET: _b, ...sinTasquesSecret } = entornoValido;
    expect(() => parsearEnv(sinTasquesSecret)).toThrow(/TASQUES_SECRET/);
  });

  it('TASQUES_OIDC_AUDIENCE es opcional, pero tiene que ser una URL válida si viene', () => {
    const sinAudiencia = parsearEnv(entornoValido);
    expect(sinAudiencia.TASQUES_OIDC_AUDIENCE).toBeUndefined();

    expect(() => parsearEnv({ ...entornoValido, TASQUES_OIDC_AUDIENCE: 'no-es-url' })).toThrow(
      /TASQUES_OIDC_AUDIENCE/,
    );

    const conAudiencia = parsearEnv({
      ...entornoValido,
      TASQUES_OIDC_AUDIENCE: 'https://backend-xyz.run.app/tasques/sync-comandes',
    });
    expect(conAudiencia.TASQUES_OIDC_AUDIENCE).toBe(
      'https://backend-xyz.run.app/tasques/sync-comandes',
    );
  });

  describe('guarda de host de prueba en WC_BASE_URL (fuera de producción)', () => {
    it('rechaza un host real fuera de producción, aunque sea una URL válida', () => {
      expect(() =>
        parsearEnv({
          ...entornoValido,
          NODE_ENV: 'development',
          WC_BASE_URL: 'https://dpages.cat',
        }),
      ).toThrow(/WC_BASE_URL/);

      expect(() =>
        parsearEnv({ ...entornoValido, NODE_ENV: 'test', WC_BASE_URL: 'https://dpages.cat' }),
      ).toThrow(/WC_BASE_URL/);
    });

    it('acepta localhost, *.invalid y *.test fuera de producción', () => {
      for (const url of [
        'http://localhost:8080',
        'https://woocommerce-test.invalid',
        'https://api.example.test',
      ]) {
        expect(() =>
          parsearEnv({ ...entornoValido, NODE_ENV: 'development', WC_BASE_URL: url }),
        ).not.toThrow();
      }
    });

    it('permite un host real cuando NODE_ENV es production', () => {
      expect(() =>
        parsearEnv({ ...entornoValido, NODE_ENV: 'production', WC_BASE_URL: 'https://dpages.cat' }),
      ).not.toThrow();
    });
  });

  describe('ADR-017 — ventana de la primera carga sin cursor', () => {
    it('INGESTA_DIES_ENRERE_DEFECTE por defecto son 30 días', () => {
      expect(parsearEnv(entornoValido).INGESTA_DIES_ENRERE_DEFECTE).toBe(30);
    });

    it('acepta un valor distinto, coaccionado a número', () => {
      expect(
        parsearEnv({ ...entornoValido, INGESTA_DIES_ENRERE_DEFECTE: '7' })
          .INGESTA_DIES_ENRERE_DEFECTE,
      ).toBe(7);
    });

    it('INGESTA_HISTORIC_COMPLET es false por defecto, y sólo "true" literal lo activa', () => {
      expect(parsearEnv(entornoValido).INGESTA_HISTORIC_COMPLET).toBe(false);
      expect(
        parsearEnv({ ...entornoValido, INGESTA_HISTORIC_COMPLET: 'false' })
          .INGESTA_HISTORIC_COMPLET,
      ).toBe(false);
      expect(
        parsearEnv({ ...entornoValido, INGESTA_HISTORIC_COMPLET: 'cualquier-cosa' })
          .INGESTA_HISTORIC_COMPLET,
      ).toBe(false);
      expect(
        parsearEnv({ ...entornoValido, INGESTA_HISTORIC_COMPLET: 'true' }).INGESTA_HISTORIC_COMPLET,
      ).toBe(true);
    });
  });

  describe('piso de activación para pedidos de WooCommerce — INGESTA_COMANDES_DES_DE', () => {
    it('es opcional: sin ella, undefined (incluso con NODE_ENV=production — ver transform/comandes.ts para el fallo cerrado en runtime)', () => {
      expect(parsearEnv(entornoValido).INGESTA_COMANDES_DES_DE).toBeUndefined();
      expect(
        parsearEnv({ ...entornoValido, NODE_ENV: 'production' }).INGESTA_COMANDES_DES_DE,
      ).toBeUndefined();
    });

    it('acepta una fecha ISO 8601 con zona', () => {
      expect(
        parsearEnv({ ...entornoValido, INGESTA_COMANDES_DES_DE: '2026-10-08T07:00:00Z' })
          .INGESTA_COMANDES_DES_DE,
      ).toBe('2026-10-08T07:00:00Z');
    });

    it('rechaza una fecha sin zona o con formato inválido', () => {
      expect(() =>
        parsearEnv({ ...entornoValido, INGESTA_COMANDES_DES_DE: '2026-10-08T07:00:00' }),
      ).toThrow(ErrorConfiguracion);
      expect(() =>
        parsearEnv({ ...entornoValido, INGESTA_COMANDES_DES_DE: 'no-es-una-fecha' }),
      ).toThrow(ErrorConfiguracion);
    });
  });

  describe('ADR-021 — guarda de AUTH_DISABLED', () => {
    it('AUTH_DISABLED es false por defecto, y sólo "true" literal lo activa', () => {
      expect(parsearEnv(entornoValido).AUTH_DISABLED).toBe(false);
      expect(parsearEnv({ ...entornoValido, AUTH_DISABLED: 'cualquier-cosa' }).AUTH_DISABLED).toBe(
        false,
      );
      expect(parsearEnv({ ...entornoValido, AUTH_DISABLED: 'true' }).AUTH_DISABLED).toBe(true);
    });

    it('rechaza AUTH_DISABLED=true con NODE_ENV=production', () => {
      expect(() =>
        parsearEnv({ ...entornoValido, NODE_ENV: 'production', AUTH_DISABLED: 'true' }),
      ).toThrow(/AUTH_DISABLED/);
    });

    it('acepta AUTH_DISABLED=true fuera de producción', () => {
      expect(() =>
        parsearEnv({ ...entornoValido, NODE_ENV: 'development', AUTH_DISABLED: 'true' }),
      ).not.toThrow();
    });

    it('permite NODE_ENV=production sin AUTH_DISABLED', () => {
      expect(() => parsearEnv({ ...entornoValido, NODE_ENV: 'production' })).not.toThrow();
    });
  });

  describe('capa 10 — CORS_ORIGIN', () => {
    it('es opcional: sin ella, undefined (fuera de producción no se usa igual, ver http/cors.ts)', () => {
      expect(parsearEnv(entornoValido).CORS_ORIGIN).toBeUndefined();
    });

    it('tiene que ser una URL válida si viene', () => {
      expect(() => parsearEnv({ ...entornoValido, CORS_ORIGIN: 'no-es-una-url' })).toThrow(
        /CORS_ORIGIN/,
      );
    });

    it('acepta una URL válida', () => {
      expect(
        parsearEnv({ ...entornoValido, CORS_ORIGIN: 'https://app.dpages.cat' }).CORS_ORIGIN,
      ).toBe('https://app.dpages.cat');
    });
  });
});
