import type { BadgeVariant } from '@/components/ui/Badge';

/**
 * Etiquetes dels 5 estats de comanda (contracte, secció 3), compartides per
 * Comandes, el formulari, Panell Oficina i el seu detall — abans cada
 * pantalla en tenia una còpia pròpia. L'ordre és el dels filtres d'estat.
 */
export const ESTAT_LABELS: Record<string, string> = {
  oberta: 'Oberta',
  en_proces: 'En procés',
  tancada: 'Tancada',
  amb_incidencia: 'Amb incidència',
  cancellada: 'Cancel·lada',
};

/**
 * amb_incidencia = vermell (cal mirar-la), cancellada = neutral (ja no
 * compta a cap panell, petició d'Ari 29/09/2026), la resta = info.
 */
export function estatBadgeVariant(estat: string): BadgeVariant {
  if (estat === 'amb_incidencia') return 'negative';
  if (estat === 'cancellada') return 'neutral';
  return 'info';
}
