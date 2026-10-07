/**
 * Tasca 39 (03/10/2026): data de producció inicial d'una comanda nova de
 * WooCommerce. Les que entren de dimarts a les 16:00 fins a diumenge a les
 * 24:00 (hora de Catalunya) es produeixen el dilluns següent; la resta
 * (dilluns i dimarts abans de les 16:00) entren sense data i oficina la
 * posa a mà en revisar l'esborrany.
 *
 * Retorna la data com la guarda el formulari (mitjanit UTC del dia,
 * "2026-10-05T00:00:00Z"), o null.
 */
const ZONA = 'Europe/Madrid';
const HORA_TALL_DIMARTS = 16;

const formatador = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  hourCycle: 'h23',
});

const DIES: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function calcularDataProduccioWoo(creacio: Date): Date | null {
  const parts = Object.fromEntries(formatador.formatToParts(creacio).map((p) => [p.type, p.value]));
  const dia = DIES[parts.weekday!]!;
  const hora = Number(parts.hour);

  if (dia === 1 || (dia === 2 && hora < HORA_TALL_DIMARTS)) return null;

  // Dia local de creació a mitjanit UTC, i d'aquí fins al dilluns següent.
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(local + (8 - dia) * 24 * 60 * 60 * 1000);
}
