import type { ProducteApi, RespostaPaginada } from '@dpages/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { construirServidor as construirServidorType } from '../../servidor.js';
import {
  cuerpoJson,
  type EntornTestApi,
  netejarEntornApi,
  prepararEntornApi,
} from './test-suport.js';

describe('API negoci — /productes (Postgres real, esquema aislado)', () => {
  let entorn: EntornTestApi;
  let construirServidor: typeof construirServidorType;

  beforeAll(async () => {
    entorn = await prepararEntornApi('productes');
    construirServidor = entorn.construirServidor;

    await entorn.poolTest.query(
      `INSERT INTO producte (codi, descripcio, pes_kg, tipus) VALUES ('LLF01', 'Llom fresc de porc', '1.250', 'simple')`,
    );
    await entorn.poolTest.query(
      `INSERT INTO producte (codi, descripcio, tipus) VALUES ('PIC01', 'Picada de porc', 'simple')`,
    );
    // agrupacio_produccio con mayúscula inicial, para el test de filtro
    // case-insensitive de más abajo.
    await entorn.poolTest.query(
      `INSERT INTO producte (codi, descripcio, tipus, agrupacio_produccio)
       VALUES ('COS01', 'Costelletes de porc', 'simple', 'Costelletes')`,
    );
  });

  afterAll(() => netejarEntornApi(entorn));

  it('GET /productes: pesKg null es un valor funcional, no un error', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/productes?mida=10' });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<RespostaPaginada<ProducteApi>>(res);
    expect(cuerpo.paginacio.total).toBe(3);

    const llom = cuerpo.dades.find((p) => p.codi === 'LLF01');
    const picada = cuerpo.dades.find((p) => p.codi === 'PIC01');
    expect(llom?.pesKg).toBe('1.250');
    expect(picada?.pesKg).toBeNull();

    await fastify.close();
  });

  it('GET /productes?cerca= busca pel PRINCIPI del text (tasca 18), no substring', async () => {
    // Tasca 18 (01/10/2026): "llom" ha de trobar tots els que comencen per
    // "Llom", però no un text que el porti al mig ("Cap de llom") — abans
    // era coincidència exacta. Productes extra només per a aquest test.
    await entorn.poolTest.query(
      `INSERT INTO producte (codi, descripcio, tipus) VALUES
         ('LLS01', 'Llom sencer', 'simple'),
         ('CDL01', 'Cap de llom', 'simple')`,
    );

    const fastify = construirServidor();
    const cerca = async (text: string) =>
      cuerpoJson<RespostaPaginada<ProducteApi>>(
        await fastify.inject({
          method: 'GET',
          url: `/api/v1/productes?cerca=${encodeURIComponent(text)}`,
        }),
      ).dades.map((p) => p.codi);

    expect(new Set(await cerca('llom'))).toEqual(new Set(['LLF01', 'LLS01']));
    expect(await cerca('LLOM FRESC DE PORC')).toEqual(['LLF01']);
    // Un text del mig no troba res.
    expect(await cerca('fresc')).toEqual([]);
    // També pel principi del codi.
    expect(await cerca('cdl')).toEqual(['CDL01']);
    // Els comodins de LIKE de l'usuari es tracten com a text literal.
    expect(await cerca('%llom')).toEqual([]);
    expect(await cerca('Ll_m')).toEqual([]);

    await fastify.close();
  });

  // Este filtro quedó case-sensitive por descuido, inconsistente con
  // ?cerca= de arriba. El fixture guarda
  // 'Costelletes' (mayúscula inicial) — 'costelletes' y 'COSTELLETES'
  // tienen que matchear igual.
  it('GET /productes?agrupacioProduccio= exige coincidencia exacta, case-insensitive', async () => {
    const fastify = construirServidor();

    const minuscules = await fastify.inject({
      method: 'GET',
      url: '/api/v1/productes?agrupacioProduccio=costelletes',
    });
    const cuerpoMinuscules = cuerpoJson<RespostaPaginada<ProducteApi>>(minuscules);
    expect(cuerpoMinuscules.dades).toHaveLength(1);
    expect(cuerpoMinuscules.dades[0]?.codi).toBe('COS01');

    const majuscules = await fastify.inject({
      method: 'GET',
      url: '/api/v1/productes?agrupacioProduccio=COSTELLETES',
    });
    const cuerpoMajuscules = cuerpoJson<RespostaPaginada<ProducteApi>>(majuscules);
    expect(cuerpoMajuscules.dades).toHaveLength(1);
    expect(cuerpoMajuscules.dades[0]?.codi).toBe('COS01');

    const capMatch = await fastify.inject({
      method: 'GET',
      url: '/api/v1/productes?agrupacioProduccio=llom',
    });
    const cuerpoCapMatch = cuerpoJson<RespostaPaginada<ProducteApi>>(capMatch);
    expect(cuerpoCapMatch.dades).toHaveLength(0);

    await fastify.close();
  });

  it('POST /productes crea un artículo nuevo', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/productes',
      payload: { descripcio: 'Botifarra blanca', tipus: 'simple' },
    });

    expect(res.statusCode).toBe(201);
    const cuerpo = cuerpoJson<ProducteApi>(res);
    expect(cuerpo.descripcio).toBe('Botifarra blanca');
    expect(cuerpo.actiu).toBe(true);

    await fastify.close();
  });

  it('POST /productes sin descripció rechaza con 400 VALIDACIO', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({ method: 'POST', url: '/api/v1/productes', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { codi: 'VALIDACIO' } });

    await fastify.close();
  });

  it('PATCH /productes/:id actualiza el preu de venda', async () => {
    const fastify = construirServidor();
    const productes = await entorn.poolTest.query<{ id_seq: string }>(
      `SELECT id_seq FROM producte WHERE codi = 'LLF01'`,
    );
    const idPublic = Number(productes.rows[0]!.id_seq);

    const res = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/productes/${idPublic}`,
      payload: { preuVenda: '9.86' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ preuVenda: '9.86', codi: 'LLF01' });

    await fastify.close();
  });

  // Bug real: cambiar codi a un valor duplicado daba 500 (sin try/catch
  // alrededor del INSERT/UPDATE). Decisión de negocio confirmada: codi se
  // escribe a mano SÓLO al crear.
  it('POST /productes amb codi duplicat dona 409 CONFLICTE, no 500', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/productes',
      payload: { codi: 'LLF01', descripcio: 'Un altre producte', tipus: 'simple' }, // 'LLF01' ja existeix (seed de beforeAll)
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { codi: 'CONFLICTE' } });

    await fastify.close();
  });

  it('PATCH /productes/:id ignora un intent de canviar codi (immutable un cop creat)', async () => {
    const fastify = construirServidor();
    const productes = await entorn.poolTest.query<{ id_seq: string }>(
      `SELECT id_seq FROM producte WHERE codi = 'PIC01'`,
    );
    const idPublic = Number(productes.rows[0]!.id_seq);

    const res = await fastify.inject({
      method: 'PATCH',
      url: `/api/v1/productes/${idPublic}`,
      payload: { codi: 'CODI-QUE-NO-HAURIA-DE-QUEDAR', descripcio: 'Picada de porc (editat)' },
    });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<ProducteApi>(res);
    expect(cuerpo.descripcio).toBe('Picada de porc (editat)'); // el resto del body sí se aplica
    expect(cuerpo.codi).toBe('PIC01'); // codi, sin cambios
    expect(cuerpo.codi).not.toBe('CODI-QUE-NO-HAURIA-DE-QUEDAR');

    const fila = await entorn.poolTest.query<{ codi: string | null }>(
      `SELECT codi FROM producte WHERE id_seq = $1`,
      [idPublic],
    );
    expect(fila.rows[0]?.codi).toBe('PIC01'); // confirmado también directo en la base

    await fastify.close();
  });

  // Reproduce con datos reales: "PRESTA TALLADA 330G" aparecía 2 veces en
  // producte.descripcio, sin un desempate único en el
  // ORDER BY (sólo descripcio ASC). Con descripciones empatadas, Postgres no
  // garantiza un orden estable entre páginas — puede repetir o saltear filas.
  it('GET /productes: paginar amb mida=1 no duplica ni perd files quan dues descripcions són idèntiques', async () => {
    const fastify = construirServidor();
    const dup1 = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO producte (codi, descripcio, tipus) VALUES ('DUP01', 'PRESTA TALLADA 330G', 'simple') RETURNING id_seq`,
    );
    const dup2 = await entorn.poolTest.query<{ id_seq: string }>(
      `INSERT INTO producte (codi, descripcio, tipus) VALUES ('DUP02', 'PRESTA TALLADA 330G', 'simple') RETURNING id_seq`,
    );

    const primera = cuerpoJson<RespostaPaginada<ProducteApi>>(
      await fastify.inject({ method: 'GET', url: '/api/v1/productes?mida=1&pagina=1' }),
    );
    const total = primera.paginacio.total;

    const totsElsIds: number[] = [];
    for (let pagina = 1; pagina <= total; pagina++) {
      const cuerpo = cuerpoJson<RespostaPaginada<ProducteApi>>(
        await fastify.inject({ method: 'GET', url: `/api/v1/productes?mida=1&pagina=${pagina}` }),
      );
      expect(cuerpo.dades).toHaveLength(1);
      totsElsIds.push(cuerpo.dades[0]!.id);
    }

    // Sense duplicats ni forats entre pàgines: tants ids únics com el total,
    // i els 2 productes amb descripcio duplicada hi apareixen tots dos.
    expect(new Set(totsElsIds).size).toBe(total);
    expect(totsElsIds).toContain(Number(dup1.rows[0]!.id_seq));
    expect(totsElsIds).toContain(Number(dup2.rows[0]!.id_seq));

    await fastify.close();
  });
});
