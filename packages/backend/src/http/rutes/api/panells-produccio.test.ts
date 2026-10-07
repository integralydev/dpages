import type { PanellProduccioApi } from '@dpages/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { construirServidor as construirServidorType } from '../../servidor.js';
import {
  cuerpoJson,
  type EntornTestApi,
  netejarEntornApi,
  prepararEntornApi,
} from './test-suport.js';

/**
 * Reproduce EXACTO el ejemplo de referencia del prototipo (docs/contrato-api.md,
 * sección 4.10): 6 agrupaciones con valores dados (2 KG + 4 PAQ) más 3
 * agrupaciones MAGRE cuyos números individuales no vienen en el enunciado —
 * sólo su contribución a los totales (totalKgMagro=125, y el resto de
 * totalKgAElaborar=512.982 después de restar las dos KG). Se construyen acá
 * con valores propios (PERNIL/ESPATLLA/PAPADA, kg_per_unitat 12/6/7,
 * sumando exactamente 387.979 de kgAElaborar) para que el total cierre
 * igual que el prototipo.
 */
describe('API negoci — GET /panells/produccio (Postgres real, esquema aislado)', () => {
  let entorn: EntornTestApi;
  let construirServidor: typeof construirServidorType;

  const DATA = '2026-08-20';

  async function crearAgrupacio(opts: {
    categoriaNom: string;
    agrupacioRendiment: 'KG' | 'PAQ' | 'MAGRE';
    producteCodi: string;
    agrupacioProduccio: string;
    unitatsPerPorc: string;
    kgPerUnitat: string;
    unitatsDemanades: number;
    pesCalculatKg: string;
    comandaId: string;
    ordinal: number;
  }): Promise<void> {
    let categoria = await entorn.poolTest.query<{ id: string }>(
      `SELECT id FROM categoria_producte WHERE nom = $1`,
      [opts.categoriaNom],
    );
    if (!categoria.rows[0]) {
      categoria = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO categoria_producte (nom, elaborat_porc, agrupacio_rendiment)
         VALUES ($1, true, $2) RETURNING id`,
        [opts.categoriaNom, opts.agrupacioRendiment],
      );
    }
    const producte = await entorn.poolTest.query<{ id: string }>(
      `INSERT INTO producte (codi, descripcio, tipus, categoria_id, agrupacio_produccio)
       VALUES ($1, $1, 'simple', $2, $3) RETURNING id`,
      [opts.producteCodi, categoria.rows[0]!.id, opts.agrupacioProduccio],
    );
    // Issues #3/#4: rendiments_porcs ya no se identifica por producte_id —
    // categoria_id + agrupacio_produccio, ON CONFLICT porque dos llamadas a
    // crearAgrupacio() con el mismo grupo (ver el test de grupo compartido
    // más abajo) deben reusar la MISMA fila, no fallar contra la UNIQUE.
    await entorn.poolTest.query(
      `INSERT INTO rendiments_porcs (categoria_id, agrupacio_produccio, unitats_per_porc, kg_per_unitat)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (categoria_id, agrupacio_produccio) DO NOTHING`,
      [categoria.rows[0]!.id, opts.agrupacioProduccio, opts.unitatsPerPorc, opts.kgPerUnitat],
    );
    await entorn.poolTest.query(
      `INSERT INTO comanda_linia (
         comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari,
         pes_calculat_kg, data_produccio
       ) VALUES ($1, $2, $3, $4, '0.00', $5, $6)`,
      [
        opts.comandaId,
        opts.ordinal,
        producte.rows[0]!.id,
        opts.unitatsDemanades,
        opts.pesCalculatKg,
        DATA,
      ],
    );
  }

  beforeAll(async () => {
    entorn = await prepararEntornApi('panells-produccio');
    construirServidor = entorn.construirServidor;

    const comanda = await entorn.poolTest.query<{ id: string }>(
      `INSERT INTO comanda (origen_id, estat, data_comanda)
       VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), 'oberta', '2026-08-01') RETURNING id`,
    );
    const comandaId = comanda.rows[0]!.id;

    // KG — valores dados en el enunciado.
    await crearAgrupacio({
      categoriaNom: 'Peces Nobles KG',
      agrupacioRendiment: 'KG',
      producteCodi: 'COSTELLETA',
      agrupacioProduccio: 'COSTELLETA',
      unitatsPerPorc: '2.00',
      kgPerUnitat: '12.000',
      unitatsDemanades: 1,
      pesCalculatKg: '35.000',
      comandaId,
      ordinal: 0,
    });
    await crearAgrupacio({
      categoriaNom: 'Peces Nobles KG',
      agrupacioRendiment: 'KG',
      producteCodi: 'LLOM',
      agrupacioProduccio: 'LLOM',
      unitatsPerPorc: '2.00',
      kgPerUnitat: '2.500',
      unitatsDemanades: 1,
      pesCalculatKg: '90.003',
      comandaId,
      ordinal: 1,
    });

    // PAQ — valores dados en el enunciado (kgPerUnitat de la ficha no se usa
    // en la fórmula PAQ, pero la columna es NOT NULL — valor arbitrario).
    await crearAgrupacio({
      categoriaNom: 'Peces Nobles PAQ',
      agrupacioRendiment: 'PAQ',
      producteCodi: 'GALTES',
      agrupacioProduccio: 'GALTES',
      unitatsPerPorc: '2.00',
      kgPerUnitat: '1.000',
      unitatsDemanades: 70,
      pesCalculatKg: '1.000',
      comandaId,
      ordinal: 2,
    });
    await crearAgrupacio({
      categoriaNom: 'Peces Nobles PAQ',
      agrupacioRendiment: 'PAQ',
      producteCodi: 'ORELLA',
      agrupacioProduccio: 'ORELLA',
      unitatsPerPorc: '2.00',
      kgPerUnitat: '1.000',
      unitatsDemanades: 35,
      pesCalculatKg: '1.000',
      comandaId,
      ordinal: 3,
    });
    await crearAgrupacio({
      categoriaNom: 'Peces Nobles PAQ',
      agrupacioRendiment: 'PAQ',
      producteCodi: 'PEUS',
      agrupacioProduccio: 'PEUS',
      unitatsPerPorc: '4.00',
      kgPerUnitat: '1.000',
      unitatsDemanades: 132,
      pesCalculatKg: '1.000',
      comandaId,
      ordinal: 4,
    });
    await crearAgrupacio({
      categoriaNom: 'Peces Nobles PAQ',
      agrupacioRendiment: 'PAQ',
      producteCodi: 'SECRET',
      agrupacioProduccio: 'SECRET',
      unitatsPerPorc: '2.00',
      kgPerUnitat: '1.000',
      unitatsDemanades: 140,
      pesCalculatKg: '1.000',
      comandaId,
      ordinal: 5,
    });

    // MAGRE — tres agrupaciones (nombres arbitrarios, PERNIL/ESPATLLA/
    // PAPADA no coinciden con las agrupaciones reales de negocio), con
    // kgAElaborar propios que suman 387.979 — ese es el totalKgAElaborar
    // esperado (sólo MAGRE, ya no KG+MAGRE). kgJamon/kgRecortes/
    // kgPaletillas/totalKgMagro son constantes fijas — no dependen de esta
    // fixture en absoluto.
    await crearAgrupacio({
      categoriaNom: 'Peces Magres',
      agrupacioRendiment: 'MAGRE',
      producteCodi: 'PERNIL',
      agrupacioProduccio: 'PERNIL',
      unitatsPerPorc: '1.00',
      kgPerUnitat: '12.000',
      unitatsDemanades: 1,
      pesCalculatKg: '150.000',
      comandaId,
      ordinal: 6,
    });
    await crearAgrupacio({
      categoriaNom: 'Peces Magres',
      agrupacioRendiment: 'MAGRE',
      producteCodi: 'ESPATLLA',
      agrupacioProduccio: 'ESPATLLA',
      unitatsPerPorc: '1.00',
      kgPerUnitat: '6.000',
      unitatsDemanades: 1,
      pesCalculatKg: '137.979',
      comandaId,
      ordinal: 7,
    });
    await crearAgrupacio({
      categoriaNom: 'Peces Magres',
      agrupacioRendiment: 'MAGRE',
      producteCodi: 'PAPADA',
      agrupacioProduccio: 'PAPADA',
      unitatsPerPorc: '1.00',
      kgPerUnitat: '7.000',
      unitatsDemanades: 1,
      pesCalculatKg: '100.000',
      comandaId,
      ordinal: 8,
    });
  });

  afterAll(() => netejarEntornApi(entorn));

  it('nombrePorcs=5 reproduce exacto los 6 renglones KG/PAQ y los totales del prototipo', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/v1/panells/produccio?nombrePorcs=5&dataDes=${DATA}&dataFins=${DATA}&mida=50`,
    });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<PanellProduccioApi>(res);

    const porAgrupacio = new Map(cuerpo.dades.map((f) => [f.agrupacioProduccio, f]));

    expect(porAgrupacio.get('COSTELLETA')).toMatchObject({
      agrupacioRendiment: 'KG',
      kgAElaborar: '35.000',
      rendiment: '120.000',
      diferencia: '85.000',
      paqPedido: null,
    });
    expect(porAgrupacio.get('LLOM')).toMatchObject({
      agrupacioRendiment: 'KG',
      kgAElaborar: '90.003',
      rendiment: '25.000',
      diferencia: '-65.003',
      paqPedido: null,
    });
    expect(porAgrupacio.get('GALTES')).toMatchObject({
      agrupacioRendiment: 'PAQ',
      paqPedido: '70.00',
      rendiment: '10.00',
      diferencia: '-60.00',
      kgAElaborar: null,
    });
    expect(porAgrupacio.get('ORELLA')).toMatchObject({
      agrupacioRendiment: 'PAQ',
      paqPedido: '35.00',
      rendiment: '10.00',
      diferencia: '-25.00',
      kgAElaborar: null,
    });
    expect(porAgrupacio.get('PEUS')).toMatchObject({
      agrupacioRendiment: 'PAQ',
      paqPedido: '132.00',
      rendiment: '20.00',
      diferencia: '-112.00',
      kgAElaborar: null,
    });
    expect(porAgrupacio.get('SECRET')).toMatchObject({
      agrupacioRendiment: 'PAQ',
      paqPedido: '140.00',
      rendiment: '10.00',
      diferencia: '-130.00',
      kgAElaborar: null,
    });

    // Las tres filas MAGRE: sin cálculo por línia (rendiment/diferencia null).
    for (const codi of ['PERNIL', 'ESPATLLA', 'PAPADA']) {
      const fila = porAgrupacio.get(codi);
      expect(fila?.agrupacioRendiment).toBe('MAGRE');
      expect(fila?.rendiment).toBeNull();
      expect(fila?.diferencia).toBeNull();
      expect(fila?.paqPedido).toBeNull();
      expect(fila?.kgAElaborar).not.toBeNull();
    }

    expect(cuerpo.dades).toHaveLength(9);
    expect(cuerpo.totals).toEqual({
      // "Total Kg a elaborar" suma EXCLUSIVAMENTE MAGRE (antes sumaba
      // KG+MAGRE: 125.003 + 387.979 = 512.982). Este dataset tiene
      // PERNIL/ESPATLLA/PAPADA con unitatsPerPorc='1.00' (ver
      // crearAgrupacio más arriba), así que totalKgMagro no cambia con el
      // otro fix (unitatsPerPorc×1 = mismo valor) — el test dedicado de
      // más abajo cubre unitatsPerPorc≠1.
      totalKgAElaborar: '387.979',
      // kgJamon/kgRecortes/kgPaletillas son constantes fijas (12/6/7 ×
      // nombrePorcs), NO calculadas desde rendiments_porcs (ya se intentó
      // conectarlas y se revirtió: es una tasa de negocio fija e
      // independiente). Con nombrePorcs=5: 60+30+35=125, coincide con
      // totalKgMagro (pura coincidencia con este fixture, no por diseño).
      totalKgMagro: '125.000',
      diferencia: '-262.979',
      kgJamon: '60.000',
      kgRecortes: '30.000',
      kgPaletillas: '35.000',
      // Sin líneas de categoria CANALS en este dataset de prueba.
      canals: { unitats: '0', kg: '0' },
      mitgesCanals: { unitats: '0', kg: '0' },
    });

    await fastify.close();
  });

  it('capa 24 — kgJamon/kgRecortes/kgPaletillas escalan linealmente con nombrePorcs (12/6/7 kg por cerdo, Francesc)', async () => {
    const fastify = construirServidor();

    const conUnPorc = cuerpoJson<PanellProduccioApi>(
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/panells/produccio?nombrePorcs=1&dataDes=${DATA}&dataFins=${DATA}`,
      }),
    );
    expect(conUnPorc.totals.kgJamon).toBe('12.000');
    expect(conUnPorc.totals.kgRecortes).toBe('6.000');
    expect(conUnPorc.totals.kgPaletillas).toBe('7.000');

    // Ejemplo confirmado: 10 cerdos → Jamón 120, Recortes 60, Paletillas 70.
    const conDiezPorcs = cuerpoJson<PanellProduccioApi>(
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/panells/produccio?nombrePorcs=10&dataDes=${DATA}&dataFins=${DATA}`,
      }),
    );
    expect(conDiezPorcs.totals.kgJamon).toBe('120.000');
    expect(conDiezPorcs.totals.kgRecortes).toBe('60.000');
    expect(conDiezPorcs.totals.kgPaletillas).toBe('70.000');

    await fastify.close();
  });

  it('sin nombrePorcs devuelve 400 VALIDACIO (no hay default silencioso)', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/panells/produccio' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { codi: 'VALIDACIO' } });

    await fastify.close();
  });

  it('con nombrePorcs=0 devuelve 400 VALIDACIO', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/panells/produccio?nombrePorcs=0',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { codi: 'VALIDACIO' } });

    await fastify.close();
  });

  it('?agrupacioRendiment=KG filtra sólo esa agrupación', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/v1/panells/produccio?nombrePorcs=5&dataDes=${DATA}&dataFins=${DATA}&agrupacioRendiment=KG`,
    });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<PanellProduccioApi>(res);
    expect(cuerpo.dades).toHaveLength(2);
    expect(cuerpo.dades.every((f) => f.agrupacioRendiment === 'KG')).toBe(true);
    // "Total Kg a elaborar" es EXCLUSIVAMENTE MAGRE: filtrando por KG no
    // hay ninguna línia MAGRE en `filas`, así que da "0.000" (antes daba
    // la suma de las 2 filas KG mostradas, 125.003 — mezclaba lo que se ve
    // en la tabla con lo que muestra esta tarjeta puntual, que son cosas
    // distintas por diseño).
    expect(cuerpo.totals.totalKgAElaborar).toBe('0.000');
    // totalKgMagro es constante fija (12+6+7)×nombrePorcs — NO depende de
    // agrupacioRendiment.
    expect(cuerpo.totals.totalKgMagro).toBe('125.000');

    await fastify.close();
  });

  it('?producte= exige coincidencia exacta (case-insensitive), no substring', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/v1/panells/produccio?nombrePorcs=5&dataDes=${DATA}&dataFins=${DATA}&producte=llom`,
    });

    const cuerpo = cuerpoJson<PanellProduccioApi>(res);
    expect(cuerpo.dades).toHaveLength(1);
    // producteCodi/descripcio y agrupacioProduccio valen 'LLOM' los tres en
    // este fixture (ver crearAgrupacio) — agrupacioProduccio confirma que
    // matcheó la fila correcta ahora que producte ya no viaja.
    expect(cuerpo.dades[0]?.agrupacioProduccio).toBe('LLOM');
    expect(cuerpo.dades[0]).not.toHaveProperty('producte');

    const exacte = await fastify.inject({
      method: 'GET',
      url: `/api/v1/panells/produccio?nombrePorcs=5&dataDes=${DATA}&dataFins=${DATA}&producte=LLOM`,
    });
    expect(cuerpoJson<PanellProduccioApi>(exacte).dades).toHaveLength(1);

    await fastify.close();
  });

  it('fuera del rango de fechas no aparece nada', async () => {
    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/panells/produccio?nombrePorcs=5&dataDes=2026-01-01&dataFins=2026-01-02',
    });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<PanellProduccioApi>(res);
    expect(cuerpo.dades).toHaveLength(0);
    expect(cuerpo.totals).toEqual({
      totalKgAElaborar: '0.000',
      // kgJamon/kgRecortes/kgPaletillas/totalKgMagro son constantes fijas
      // × nombrePorcs — NO dependen de si hay datos en el rango filtrado
      // (ya se intentó conectarlas a rendiments_porcs y se revirtió).
      totalKgMagro: '125.000',
      diferencia: '125.000',
      kgJamon: '60.000',
      kgRecortes: '30.000',
      kgPaletillas: '35.000',
      // Fuera del rango de fechas — tampoco hay líneas CANALS que sumar.
      canals: { unitats: '0', kg: '0' },
      mitgesCanals: { unitats: '0', kg: '0' },
    });

    await fastify.close();
  });

  /**
   * Issues #3/#4 — el bug de fondo que motivó la migración a
   * clave por agrupació: bajo el modelo viejo (rendiments_porcs por
   * producte_id), cargar el rendimiento de UN producto del grupo no
   * beneficiaba a los demás — el join `rp.producte_id = p.id` sólo
   * encontraba la fila para ese producto puntual, el resto de las líneas
   * de la misma agrupació quedaban con rp NULL, en silencio. Este test crea
   * DOS productos en la MISMA categoria + agrupacio_produccio, con una
   * ÚNICA fila de rendiment (ahora keyed por categoria_id +
   * agrupacio_produccio, no por ninguno de los dos producte_id) y confirma
   * que el cálculo del panel usa ese rendimiento para AMBOS productos —
   * tanto en el total agregado (kgAElaborar) como en el propio rendiment.
   */
  it('un rendiment por agrupació cubre a TODOS los productos del grupo, no sólo a uno', async () => {
    const categoria = await entorn.poolTest.query<{ id: string }>(
      `INSERT INTO categoria_producte (nom, elaborat_porc, agrupacio_rendiment)
       VALUES ('Peces Compartides', true, 'KG') RETURNING id`,
    );
    const producteA = await entorn.poolTest.query<{ id: string }>(
      `INSERT INTO producte (codi, descripcio, tipus, categoria_id, agrupacio_produccio)
       VALUES ('COMP-A', 'COMP-A', 'simple', $1, 'LOM_COMPARTIT') RETURNING id`,
      [categoria.rows[0]!.id],
    );
    const producteB = await entorn.poolTest.query<{ id: string }>(
      `INSERT INTO producte (codi, descripcio, tipus, categoria_id, agrupacio_produccio)
       VALUES ('COMP-B', 'COMP-B', 'simple', $1, 'LOM_COMPARTIT') RETURNING id`,
      [categoria.rows[0]!.id],
    );

    // UNA sola fila de rendiment para el grupo — ninguno de los dos
    // producte_id existe ya en este esquema, la fila no apunta a ninguno.
    await entorn.poolTest.query(
      `INSERT INTO rendiments_porcs (categoria_id, agrupacio_produccio, unitats_per_porc, kg_per_unitat)
       VALUES ($1, 'LOM_COMPARTIT', '2.00', '5.000')`,
      [categoria.rows[0]!.id],
    );

    const comanda = await entorn.poolTest.query<{ id: string }>(
      `INSERT INTO comanda (origen_id, estat, data_comanda)
       VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), 'oberta', '2026-08-01') RETURNING id`,
    );
    await entorn.poolTest.query(
      `INSERT INTO comanda_linia (
         comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari,
         pes_calculat_kg, data_produccio
       ) VALUES ($1, 0, $2, 1, '0.00', '10.000', $3)`,
      [comanda.rows[0]!.id, producteA.rows[0]!.id, DATA],
    );
    await entorn.poolTest.query(
      `INSERT INTO comanda_linia (
         comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari,
         pes_calculat_kg, data_produccio
       ) VALUES ($1, 1, $2, 1, '0.00', '20.000', $3)`,
      [comanda.rows[0]!.id, producteB.rows[0]!.id, DATA],
    );

    const fastify = construirServidor();
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/v1/panells/produccio?nombrePorcs=5&dataDes=${DATA}&dataFins=${DATA}&agrupacioRendiment=KG`,
    });

    expect(res.statusCode).toBe(200);
    const cuerpo = cuerpoJson<PanellProduccioApi>(res);
    const fila = cuerpo.dades.find((f) => f.agrupacioProduccio === 'LOM_COMPARTIT');

    // Las dos líneas (COMP-A: 10.000kg, COMP-B: 20.000kg) suman en UNA sola
    // fila de agrupació — confirma que ambos productos cayeron en el mismo
    // grupo del panel.
    expect(fila?.kgAElaborar).toBe('30.000');
    // rendiment = unitatsPerPorc(2.00) × kgPerUnitat(5.000) × nombrePorcs(5)
    // = 50.000 — si el join siguiera atado a un producte_id puntual, esto
    // daría null para el producto que "no tuviera" la fila de rendiment.
    expect(fila?.rendiment).toBe('50.000');
    expect(fila?.diferencia).toBe('20.000');

    await fastify.close();
  });

  // Principio confirmado: "sin datos = todos los datos", para TODOS los
  // filtros del sistema. Antes, sin dataDes/dataFins el backend sustituía
  // por un rango oculto interno (mañana a +7 días) — eso ocultaba líneas
  // elegibles fuera de ese rango sin que nadie lo hubiera pedido. Fixtures
  // propios con fechas MUY separadas (2020 y 2030) para no depender de la
  // fecha real del sistema.
  describe('"sin datos = todos los datos" — GET /panells/produccio sin dataDes/dataFins', () => {
    let comandaFiltreId: string;

    beforeAll(async () => {
      const categoria = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO categoria_producte (nom, elaborat_porc, agrupacio_rendiment)
         VALUES ('Categoria Filtre Dates', true, 'KG') RETURNING id`,
      );
      const antiga = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO producte (codi, descripcio, tipus, categoria_id, agrupacio_produccio)
         VALUES ('FILTRE-ANTIGA', 'FILTRE-ANTIGA', 'simple', $1, 'FILTRE-ANTIGA') RETURNING id`,
        [categoria.rows[0]!.id],
      );
      const futura = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO producte (codi, descripcio, tipus, categoria_id, agrupacio_produccio)
         VALUES ('FILTRE-FUTURA', 'FILTRE-FUTURA', 'simple', $1, 'FILTRE-FUTURA') RETURNING id`,
        [categoria.rows[0]!.id],
      );
      const comanda = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO comanda (origen_id, estat, data_comanda)
         VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), 'oberta', '2020-01-01') RETURNING id`,
      );
      comandaFiltreId = comanda.rows[0]!.id;
      await entorn.poolTest.query(
        `INSERT INTO comanda_linia (
           comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari,
           pes_calculat_kg, data_produccio
         ) VALUES ($1, 0, $2, 1, '0.00', '5.000', '2020-01-01')`,
        [comandaFiltreId, antiga.rows[0]!.id],
      );
      await entorn.poolTest.query(
        `INSERT INTO comanda_linia (
           comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari,
           pes_calculat_kg, data_produccio
         ) VALUES ($1, 1, $2, 1, '0.00', '5.000', '2030-01-01')`,
        [comandaFiltreId, futura.rows[0]!.id],
      );
    });

    it('sense dataDes ni dataFins: apareixen línies amb data_produccio molt separades (2020 i 2030)', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/produccio?nombrePorcs=5&mida=200',
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      expect(cuerpo.dades.some((f) => f.agrupacioProduccio === 'FILTRE-ANTIGA')).toBe(true);
      expect(cuerpo.dades.some((f) => f.agrupacioProduccio === 'FILTRE-FUTURA')).toBe(true);

      await fastify.close();
    });

    it('només dataDes: aplica només el límit inferior', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/produccio?nombrePorcs=5&mida=200&dataDes=2025-01-01',
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      expect(cuerpo.dades.some((f) => f.agrupacioProduccio === 'FILTRE-FUTURA')).toBe(true);
      expect(cuerpo.dades.some((f) => f.agrupacioProduccio === 'FILTRE-ANTIGA')).toBe(false);

      await fastify.close();
    });

    it('només dataFins: aplica només el límit superior', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/produccio?nombrePorcs=5&mida=200&dataFins=2025-01-01',
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      expect(cuerpo.dades.some((f) => f.agrupacioProduccio === 'FILTRE-ANTIGA')).toBe(true);
      expect(cuerpo.dades.some((f) => f.agrupacioProduccio === 'FILTRE-FUTURA')).toBe(false);

      await fastify.close();
    });

    it('amb dataDes i dataFins: sense canvis de comportament (regressió) — sólo la línia dentro del rango', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/produccio?nombrePorcs=5&mida=200&dataDes=2019-12-01&dataFins=2020-02-01',
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      expect(cuerpo.dades.some((f) => f.agrupacioProduccio === 'FILTRE-ANTIGA')).toBe(true);
      expect(cuerpo.dades.some((f) => f.agrupacioProduccio === 'FILTRE-FUTURA')).toBe(false);

      await fastify.close();
    });
  });

  // Sumatorio nuevo, totalmente independiente del resto del panel — CANALS
  // tiene
  // elaborat_porc=false A PROPÓSITO, por eso nunca puede aparecer en
  // `dades` (que exige elaborat_porc=true), pero sí necesita su propio
  // total agregado, sensible sólo al filtro de fecha y al estat='oberta'.
  describe('totals.canals — sumatorio de CANALS, independiente del resto del panel', () => {
    beforeAll(async () => {
      const categoria = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO categoria_producte (nom, elaborat_porc, agrupacio_rendiment)
         VALUES ('CANALS', false, NULL) RETURNING id`,
      );
      const producte = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO producte (codi, descripcio, tipus, categoria_id)
         VALUES ('CANALS-TEST', 'CANALS-TEST', 'simple', $1) RETURNING id`,
        [categoria.rows[0]!.id],
      );

      const comanda = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO comanda (origen_id, estat, data_comanda)
         VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), 'oberta', '2026-08-01') RETURNING id`,
      );
      await entorn.poolTest.query(
        `INSERT INTO comanda_linia (
           comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari,
           pes_calculat_kg, data_produccio
         ) VALUES ($1, 0, $2, 3, '0.00', '15.500', $3)`,
        [comanda.rows[0]!.id, producte.rows[0]!.id, DATA],
      );

      // Misma categoria/producto, pedido NO oberta — nunca debe sumar acá,
      // aunque tenga muchas más unidades/kg que la línia de arriba (si
      // sumara, el total no daría exactamente 3.00/15.500 más abajo).
      const comandaTancada = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO comanda (origen_id, estat, data_comanda)
         VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), 'tancada', '2026-08-01') RETURNING id`,
      );
      await entorn.poolTest.query(
        `INSERT INTO comanda_linia (
           comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari,
           pes_calculat_kg, data_produccio
         ) VALUES ($1, 0, $2, 100, '0.00', '999.000', $3)`,
        [comandaTancada.rows[0]!.id, producte.rows[0]!.id, DATA],
      );
    });

    it('suma unitats/kg de la línia oberta dentro del rango de fecha, ignorando la línia tancada', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/panells/produccio?nombrePorcs=5&dataDes=${DATA}&dataFins=${DATA}`,
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      // elaborat_porc=false — CANALS no puede aparecer nunca en `dades`.
      expect(cuerpo.dades.some((f) => f.categoria === 'CANALS')).toBe(false);
      expect(cuerpo.totals.canals).toEqual({ unitats: '3.00', kg: '15.500' });

      await fastify.close();
    });

    it('agrupacioRendiment i producte de la taula principal NO afecten totals.canals', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        // Filtros que sí afectan `dades` (agrupacioRendiment=KG, un
        // producte real de la tabla principal) — totals.canals debe dar
        // exactamente el mismo valor que sin ellos.
        url: `/api/v1/panells/produccio?nombrePorcs=5&dataDes=${DATA}&dataFins=${DATA}&agrupacioRendiment=KG&producte=COSTELLETA`,
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      expect(cuerpo.totals.canals).toEqual({ unitats: '3.00', kg: '15.500' });

      await fastify.close();
    });

    it('fuera del rango de fechas, totals.canals da "0"/"0" (nunca null)', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/produccio?nombrePorcs=5&dataDes=2019-01-01&dataFins=2019-01-02',
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      expect(cuerpo.totals.canals).toEqual({ unitats: '0', kg: '0' });

      await fastify.close();
    });

    // Issue #18 — "sense dades = totes les dades" aplica también a CANALS:
    // sin dataDes NI dataFins, la línia oberta de CANALS (creada arriba,
    // fecha DATA) tiene que aparecer igual, sin que el endpoint le aplique
    // ninguna ventana oculta por defecto.
    it('sin dataDes ni dataFins ("sin datos = todos los datos", issue #18): la línia de CANALS igual suma', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/panells/produccio?nombrePorcs=5&mida=200',
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      expect(cuerpo.totals.canals).toEqual({ unitats: '3.00', kg: '15.500' });

      await fastify.close();
    });
  });

  // Reproduce EXACTO el escenario real reportado como regresión: categoria
  // PECES MAGRES con las 4 agrupaciones reales de rendiments_porcs
  // (unitatsPerPorc≠1 en 2 de las 4, a propósito — la fixture de más
  // arriba usa siempre '1.00'). Confirma totalKgAElaborar (demanda real,
  // exclusivamente MAGRE — fix que SIGUE vigente).
  //
  // Este describe originalmente también probaba que totalKgMagro/kgJamon/
  // kgRecortes/kgPaletillas se calculaban desde estos mismos datos de
  // rendiments_porcs — esa conexión se revirtió por completo (son 3 tasas
  // fijas de negocio, sin relación con rendiments_porcs). El test de abajo
  // ahora confirma justamente lo contrario: que tener agrupaciones
  // PERNIL/RETALLS/ESPATLLA reales en rendiments_porcs NO afecta esos 4
  // campos — para que nadie repita este mismo error sin que un test lo
  // agarre.
  describe('totalKgAElaborar — datos reales de PECES MAGRES (Francesc)', () => {
    // Fecha propia ('2026-08-15'), distinta de `DATA` ('2026-08-20', usada
    // por el fixture del describe exterior) — y raw SQL en vez de
    // `crearAgrupacio` (que hardcodea `DATA`) — para quedar totalmente
    // aislado de ese otro fixture al filtrar por rango de fecha. Ya hubo un
    // intento fallido reusando 'PERNIL'/'ESPATLLA' como agrupacioProduccio
    // con la MISMA fecha: el GROUP BY de la query es por agrupacio_produccio
    // + agrupacio_rendiment (no por categoria_id), así que un nombre
    // repetido en el mismo rango de fecha mezcla las dos fixtures en una
    // sola fila (540.000 en vez de 300.000 en ese intento).
    const DATA_MAGRE_REAL = '2026-08-15';

    beforeAll(async () => {
      const categoria = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO categoria_producte (nom, elaborat_porc, agrupacio_rendiment)
         VALUES ('PECES MAGRES REAL', true, 'MAGRE') RETURNING id`,
      );
      const comanda = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO comanda (origen_id, estat, data_comanda)
         VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), 'oberta', '2026-08-01') RETURNING id`,
      );
      const comandaId = comanda.rows[0]!.id;

      // 7.0 + 12.0 + 7.0 + 4.0 = 30.0 kg/porc (dato real confirmado) — la
      // fórmula vieja (sin ×unitatsPerPorc) daba 3.5+6.0+7.0+4.0 = 20.5
      // kg/porc, un resultado distinto pero NUNCA cero.
      const grupos: {
        codi: string;
        agrupacioProduccio: string;
        unitatsPerPorc: string;
        kgPerUnitat: string;
      }[] = [
        {
          codi: 'ESPATLLA-REAL',
          agrupacioProduccio: 'ESPATLLA',
          unitatsPerPorc: '2.00',
          kgPerUnitat: '3.500',
        },
        {
          codi: 'PERNIL-REAL',
          agrupacioProduccio: 'PERNIL',
          unitatsPerPorc: '2.00',
          kgPerUnitat: '6.000',
        },
        {
          codi: 'RETALLS-1RA-REAL',
          agrupacioProduccio: 'RETALLS 1RA',
          unitatsPerPorc: '1.00',
          kgPerUnitat: '7.000',
        },
        {
          codi: 'RETALLS-2NA-REAL',
          agrupacioProduccio: 'RETALLS 2NA',
          unitatsPerPorc: '1.00',
          kgPerUnitat: '4.000',
        },
      ];
      for (const [ordinal, grup] of grupos.entries()) {
        const producte = await entorn.poolTest.query<{ id: string }>(
          `INSERT INTO producte (codi, descripcio, tipus, categoria_id, agrupacio_produccio)
           VALUES ($1, $1, 'simple', $2, $3) RETURNING id`,
          [grup.codi, categoria.rows[0]!.id, grup.agrupacioProduccio],
        );
        await entorn.poolTest.query(
          `INSERT INTO rendiments_porcs (categoria_id, agrupacio_produccio, unitats_per_porc, kg_per_unitat)
           VALUES ($1, $2, $3, $4)`,
          [categoria.rows[0]!.id, grup.agrupacioProduccio, grup.unitatsPerPorc, grup.kgPerUnitat],
        );
        await entorn.poolTest.query(
          `INSERT INTO comanda_linia (
             comanda_id, ordinal, producte_id, unitats_demanades, preu_unitari,
             pes_calculat_kg, data_produccio
           ) VALUES ($1, $2, $3, 1, '0.00', '10.000', $4)`,
          [comandaId, ordinal, producte.rows[0]!.id, DATA_MAGRE_REAL],
        );
      }
    });

    it('totalKgAElaborar = 40.0 (demanda real de las 4 agrupaciones) — totalKgMagro/kgJamon/kgRecortes/kgPaletillas NO se ven afectados por rendiments_porcs', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/panells/produccio?nombrePorcs=10&dataDes=${DATA_MAGRE_REAL}&dataFins=${DATA_MAGRE_REAL}&agrupacioRendiment=MAGRE`,
      });

      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      // Las 4 agrupaciones MAGRE de este fixture, 10.000 kg cada una —
      // demanda real, fix que sigue vigente.
      expect(cuerpo.totals.totalKgAElaborar).toBe('40.000');
      // Aunque este fixture tiene rendiments_porcs reales para
      // PERNIL/RETALLS 1RA/RETALLS 2NA/ESPATLLA (unitatsPerPorc≠1 en 2 de
      // las 4), estos 4 campos son las constantes fijas de siempre (12/6/7
      // × nombrePorcs=10), totalmente ajenos a esos datos.
      expect(cuerpo.totals.kgJamon).toBe('120.000');
      expect(cuerpo.totals.kgRecortes).toBe('60.000');
      expect(cuerpo.totals.kgPaletillas).toBe('70.000');
      expect(cuerpo.totals.totalKgMagro).toBe('250.000');

      await fastify.close();
    });
  });

  // Tasca 33 (03/10/2026): l'esborrany SÍ compta a Producció (taula i
  // canals), com l'oberta. Data pròpia perquè no toqui els altres totals.
  describe('estat esborrany — compta a Producció', () => {
    const DATA_ESB = '2026-09-15';

    beforeAll(async () => {
      const categoria = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO categoria_producte (nom, elaborat_porc, agrupacio_rendiment)
         VALUES ('ESB KG', true, 'KG') RETURNING id`,
      );
      const producte = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO producte (codi, descripcio, tipus, categoria_id, agrupacio_produccio)
         VALUES ('ESB-01', 'ESB-01', 'simple', $1, 'ESB-AGR') RETURNING id`,
        [categoria.rows[0]!.id],
      );
      let canals = await entorn.poolTest.query<{ id: string }>(
        `SELECT id FROM categoria_producte WHERE nom = 'CANALS'`,
      );
      if (!canals.rows[0]) {
        canals = await entorn.poolTest.query<{ id: string }>(
          `INSERT INTO categoria_producte (nom, elaborat_porc) VALUES ('CANALS', false) RETURNING id`,
        );
      }
      const producteCanal = await entorn.poolTest.query<{ id: string }>(
        `INSERT INTO producte (codi, descripcio, tipus, categoria_id)
         VALUES ('ESB-CANAL', 'ESB-CANAL', 'simple', $1) RETURNING id`,
        [canals.rows[0]!.id],
      );
      for (const [estat, kg, kgCanal] of [
        ['esborrany', '7.000', '4.500'],
        ['tancada', '100.000', '90.000'],
      ] as const) {
        const comanda = await entorn.poolTest.query<{ id: string }>(
          `INSERT INTO comanda (origen_id, estat, data_comanda)
           VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), $1, '2026-09-01') RETURNING id`,
          [estat],
        );
        await entorn.poolTest.query(
          `INSERT INTO comanda_linia (comanda_id, ordinal, producte_id, unitats_demanades,
             preu_unitari, pes_calculat_kg, data_produccio)
           VALUES ($1, 0, $2, 1, '0.00', $3, $5), ($1, 1, $4, 2, '0.00', $6, $5)`,
          [
            comanda.rows[0]!.id,
            producte.rows[0]!.id,
            kg,
            producteCanal.rows[0]!.id,
            DATA_ESB,
            kgCanal,
          ],
        );
      }
    });

    it("la línia d'una comanda en esborrany suma a la taula i a canals; la tancada no", async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/panells/produccio?nombrePorcs=1&dataDes=${DATA_ESB}&dataFins=${DATA_ESB}`,
      });
      expect(res.statusCode).toBe(200);
      const cuerpo = cuerpoJson<PanellProduccioApi>(res);
      expect(cuerpo.dades.find((f) => f.agrupacioProduccio === 'ESB-AGR')?.kgAElaborar).toBe(
        '7.000',
      );
      expect(cuerpo.totals.canals).toEqual({ unitats: '2.00', kg: '4.500' });

      await fastify.close();
    });
  });

  // Tasca 36 (03/10/2026): les mitges canals, a la seva categoria, tenen el
  // seu propi total i no se sumen a CANALS.
  describe('mitges canals — total propi, separat de canals', () => {
    const DATA_MITGES = '2026-09-25';

    beforeAll(async () => {
      for (const [categoria, codi, unitats, kg] of [
        ['MITJES CANALS', 'MITJCAN-TEST', '2', '110.000'],
        ['CANALS', 'CANALS-T36', '1', '95.000'],
      ] as const) {
        let cat = await entorn.poolTest.query<{ id: string }>(
          `SELECT id FROM categoria_producte WHERE nom = $1`,
          [categoria],
        );
        if (!cat.rows[0]) {
          cat = await entorn.poolTest.query<{ id: string }>(
            `INSERT INTO categoria_producte (nom, elaborat_porc) VALUES ($1, false) RETURNING id`,
            [categoria],
          );
        }
        const producte = await entorn.poolTest.query<{ id: string }>(
          `INSERT INTO producte (codi, descripcio, tipus, categoria_id)
           VALUES ($1, $1, 'simple', $2) RETURNING id`,
          [codi, cat.rows[0]!.id],
        );
        const comanda = await entorn.poolTest.query<{ id: string }>(
          `INSERT INTO comanda (origen_id, estat, data_comanda)
           VALUES ((SELECT id FROM origen_comanda WHERE codi = 'manual'), 'oberta', '2026-09-01') RETURNING id`,
        );
        await entorn.poolTest.query(
          `INSERT INTO comanda_linia (comanda_id, ordinal, producte_id, unitats_demanades,
             preu_unitari, pes_calculat_kg, data_produccio)
           VALUES ($1, 0, $2, $3, '0.00', $4, $5)`,
          [comanda.rows[0]!.id, producte.rows[0]!.id, unitats, kg, DATA_MITGES],
        );
      }
    });

    it('MITJES CANALS té el seu total i CANALS no les inclou', async () => {
      const fastify = construirServidor();
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/panells/produccio?nombrePorcs=1&dataDes=${DATA_MITGES}&dataFins=${DATA_MITGES}`,
      });
      expect(res.statusCode).toBe(200);
      const { totals } = cuerpoJson<PanellProduccioApi>(res);
      expect(totals.canals).toEqual({ unitats: '1.00', kg: '95.000' });
      expect(totals.mitgesCanals).toEqual({ unitats: '2.00', kg: '110.000' });

      await fastify.close();
    });
  });
});
