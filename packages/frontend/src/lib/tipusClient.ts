import { TIPUS_CLIENT, type TipusClient } from '@dpages/shared';

/**
 * Punt 35 (18/11/2026): noms a pantalla del tipus de client. L'ordre és el
 * dels desplegables (llistat i fitxa de clients, filtre de Comandes).
 */
export const TIPUS_CLIENT_LABELS: Record<TipusClient, string> = {
  fix: 'Fix',
  esporadic: 'Esporàdic',
};

export const TIPUS_CLIENT_OPTIONS = TIPUS_CLIENT.map((tipus) => ({
  value: tipus,
  label: TIPUS_CLIENT_LABELS[tipus],
}));

/** Del text d'un desplegable al valor de l'API (`undefined` si no és cap). */
export function tipusClientPerLabel(label: string): TipusClient | undefined {
  return TIPUS_CLIENT.find((tipus) => TIPUS_CLIENT_LABELS[tipus] === label);
}
