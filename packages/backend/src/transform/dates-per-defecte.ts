import { calcularDatesPerDefecte } from '@dpages/shared';

/**
 * Punt 38 (17/11/2026): dates inicials d'una comanda nova de WooCommerce o
 * duplicada — producció el dilluns següent al dia de la comanda (aquell
 * mateix dilluns si és dilluns) i expedició el dimarts següent. La regla és
 * `calcularDatesPerDefecte` de @dpages/shared, la mateixa que fa servir el
 * formulari de comanda nova; acá només es resol el dia en hora de
 * Catalunya, no en UTC.
 *
 * Per a les de WooCommerce substitueix la tasca 39: ja no hi ha el tall de
 * dimarts a les 16:00.
 *
 * Les dates es retornen com les guarda el formulari (mitjanit UTC del dia,
 * "2026-10-05T00:00:00Z").
 */
const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Dia de calendari "AAAA-MM-DD" d'un instant, en hora de Catalunya. */
export function diaMadrid(instant: Date): string {
  const parts = Object.fromEntries(formatador.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export interface DatesComandaNova {
  dataProduccio: Date;
  dataExpedicio: Date;
}

export function calcularDatesComandaNova(instant: Date): DatesComandaNova {
  const dia = diaMadrid(instant);
  const dates = calcularDatesPerDefecte(dia);
  if (!dates) throw new Error(`Data de comanda no vàlida: ${dia}`);
  return {
    dataProduccio: new Date(`${dates.dataProduccio}T00:00:00Z`),
    dataExpedicio: new Date(`${dates.dataExpedicio}T00:00:00Z`),
  };
}
