import { describe, expect, it } from 'vitest';
import { calcularDataProduccioWoo } from './data-produccio-woo.js';

// Setmana del 05/10/2026 (dilluns) al 11/10/2026 (diumenge), horari d'estiu
// (UTC+2); el dilluns següent és el 12/10/2026.
function calcular(utc: string): string | null {
  return calcularDataProduccioWoo(new Date(utc))?.toISOString() ?? null;
}

describe('calcularDataProduccioWoo (tasca 39)', () => {
  it('dilluns: sense data', () => {
    expect(calcular('2026-10-04T22:00:00Z')).toBeNull(); // dl 00:00 local
    expect(calcular('2026-10-05T21:59:00Z')).toBeNull(); // dl 23:59 local
  });

  it('dimarts abans de les 16:00: sense data', () => {
    expect(calcular('2026-10-06T13:59:00Z')).toBeNull(); // dt 15:59 local
  });

  it('de dimarts a les 16:00 fins a diumenge a les 24:00: el dilluns següent', () => {
    const dilluns = '2026-10-12T00:00:00.000Z';
    expect(calcular('2026-10-06T14:00:00Z')).toBe(dilluns); // dt 16:00 local
    expect(calcular('2026-10-08T09:00:00Z')).toBe(dilluns); // dj
    expect(calcular('2026-10-11T21:59:00Z')).toBe(dilluns); // dg 23:59 local
  });

  it("fa servir l'hora de Catalunya, no l'UTC", () => {
    // Dg 22:30 UTC = dl 00:30 local: ja és dilluns, sense data.
    expect(calcular('2026-10-11T22:30:00Z')).toBeNull();
    // Horari d'hivern (UTC+1): dt 15:30 UTC = 16:30 local → dilluns.
    expect(calcular('2026-11-03T15:30:00Z')).toBe('2026-11-09T00:00:00.000Z');
    expect(calcular('2026-11-03T14:30:00Z')).toBeNull(); // 15:30 local
  });
});
