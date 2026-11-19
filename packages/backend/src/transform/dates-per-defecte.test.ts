import { describe, expect, it } from 'vitest';
import { calcularDatesPerDefecte } from '@dpages/shared';
import { calcularDatesComandaNova, diaMadrid } from './dates-per-defecte.js';

// Setmana del 05/10/2026 (dilluns) al 11/10/2026 (diumenge), horari d'estiu
// (UTC+2); el dilluns següent és el 12/10/2026.
function calcular(utc: string): [string, string] {
  const dates = calcularDatesComandaNova(new Date(utc));
  return [dates.dataProduccio.toISOString(), dates.dataExpedicio.toISOString()];
}

const AQUEST_DILLUNS: [string, string] = ['2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z'];
const DILLUNS_SEGUENT: [string, string] = ['2026-10-12T00:00:00.000Z', '2026-10-13T00:00:00.000Z'];

describe('calcularDatesComandaNova (punt 38)', () => {
  it('dilluns: aquell mateix dilluns, expedició dimarts', () => {
    expect(calcular('2026-10-04T22:00:00Z')).toEqual(AQUEST_DILLUNS); // dl 00:00 local
    expect(calcular('2026-10-05T21:59:00Z')).toEqual(AQUEST_DILLUNS); // dl 23:59 local
  });

  it('de dimarts a diumenge: el dilluns següent, ja sense el tall de les 16:00', () => {
    expect(calcular('2026-10-06T08:00:00Z')).toEqual(DILLUNS_SEGUENT); // dt 10:00 local
    expect(calcular('2026-10-06T14:00:00Z')).toEqual(DILLUNS_SEGUENT); // dt 16:00 local
    expect(calcular('2026-10-08T09:00:00Z')).toEqual(DILLUNS_SEGUENT); // dj
    expect(calcular('2026-10-11T21:59:00Z')).toEqual(DILLUNS_SEGUENT); // dg 23:59 local
  });

  it("fa servir l'hora de Catalunya, no l'UTC", () => {
    // Dg 22:30 UTC = dl 00:30 local: ja és dilluns 12/10.
    expect(calcular('2026-10-11T22:30:00Z')).toEqual(DILLUNS_SEGUENT);
    // Horari d'hivern (UTC+1): dg 23:30 UTC = dl 00:30 local.
    expect(calcular('2026-11-08T23:30:00Z')).toEqual([
      '2026-11-09T00:00:00.000Z',
      '2026-11-10T00:00:00.000Z',
    ]);
  });
});

describe('calcularDatesPerDefecte (punt 38, @dpages/shared)', () => {
  it('cada dia de la setmana va al dilluns següent, i el dilluns a si mateix', () => {
    const esperat = {
      '2026-11-16': '2026-11-16', // dl
      '2026-11-17': '2026-11-23', // dt
      '2026-11-18': '2026-11-23', // dc
      '2026-11-19': '2026-11-23', // dj
      '2026-11-20': '2026-11-23', // dv
      '2026-11-21': '2026-11-23', // ds
      '2026-11-22': '2026-11-23', // dg
    };
    for (const [comanda, produccio] of Object.entries(esperat)) {
      expect(calcularDatesPerDefecte(comanda)?.dataProduccio).toBe(produccio);
    }
  });

  it("l'expedició és l'endemà de la producció, encara que canviï de mes o d'any", () => {
    expect(calcularDatesPerDefecte('2026-12-29')).toEqual({
      dataProduccio: '2027-01-04',
      dataExpedicio: '2027-01-05',
    });
    expect(calcularDatesPerDefecte('2026-11-30')).toEqual({
      dataProduccio: '2026-11-30',
      dataExpedicio: '2026-12-01',
    });
  });

  it('retorna null si la data no és vàlida', () => {
    expect(calcularDatesPerDefecte('')).toBeNull();
    expect(calcularDatesPerDefecte('2026-02-30')).toBeNull();
    expect(calcularDatesPerDefecte('17/11/2026')).toBeNull();
  });
});

describe('diaMadrid (punt 38)', () => {
  it("retorna el dia en hora de Catalunya, també quan l'UTC encara és el dia anterior", () => {
    expect(diaMadrid(new Date('2026-10-05T22:30:00Z'))).toBe('2026-10-06'); // dt 00:30 (estiu)
    expect(diaMadrid(new Date('2026-11-16T23:30:00Z'))).toBe('2026-11-17'); // dt 00:30 (hivern)
    expect(diaMadrid(new Date('2026-11-17T10:00:00Z'))).toBe('2026-11-17');
  });
});
