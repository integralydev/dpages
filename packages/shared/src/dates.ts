/**
 * Punt 38 (full de l'Ari, 17/11/2026): dates per defecte d'una comanda nova,
 * duplicada o que entra per WooCommerce.
 *
 * - Data de producció: el dilluns següent a la data de la comanda; si la
 *   comanda és d'un dilluns, aquell mateix dilluns.
 * - Data d'expedició: el dimarts següent a la data de producció (l'endemà).
 *
 * Són només valors inicials: oficina els pot canviar a mà. Substitueix la
 * regla de la tasca 39 (tall de dimarts a les 16:00) per a les de WooCommerce.
 *
 * Treballa amb dies de calendari "AAAA-MM-DD", sense hora ni zona: qui crida
 * ja ha resolt el dia local (Europe/Madrid) de la comanda.
 */
export interface DatesPerDefecte {
  dataProduccio: string;
  dataExpedicio: string;
}

const PATRO_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const UN_DIA_MS = 24 * 60 * 60 * 1000;

function aDia(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `null` si `dataComanda` no és un dia vàlid "AAAA-MM-DD". */
export function calcularDatesPerDefecte(dataComanda: string): DatesPerDefecte | null {
  const parts = PATRO_DIA.exec(dataComanda);
  if (!parts) return null;
  const any = Number(parts[1]);
  const mes = Number(parts[2]);
  const dia = Number(parts[3]);
  const ms = Date.UTC(any, mes - 1, dia);
  const data = new Date(ms);
  if (
    data.getUTCFullYear() !== any ||
    data.getUTCMonth() !== mes - 1 ||
    data.getUTCDate() !== dia
  ) {
    return null;
  }
  // getUTCDay: 0 = diumenge, 1 = dilluns … 6 = dissabte.
  const diesFinsDilluns = (8 - data.getUTCDay()) % 7;
  const produccio = ms + diesFinsDilluns * UN_DIA_MS;
  return { dataProduccio: aDia(produccio), dataExpedicio: aDia(produccio + UN_DIA_MS) };
}
