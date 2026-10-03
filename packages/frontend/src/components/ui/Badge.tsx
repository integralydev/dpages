import type { ReactNode } from 'react';

export type BadgeVariant =
  'neutral' | 'info' | 'positive' | 'negative' | 'purple' | 'amber' | 'orange' | 'yellow' | 'draft';

const VARIANT_STYLES: Record<BadgeVariant, string> = {
  neutral: 'bg-gray-100 text-gray-700',
  info: 'bg-blue-50 text-blue-700',
  positive: 'bg-green-50 text-green-700',
  negative: 'bg-red-50 text-red-700',
  // Reservats per a "Origen" (OrderForm.tsx/orders), una família
  // pròpia que no es solapi amb Estat (info=blau, negative=vermell) perquè
  // els dos badges no es confonguin a primer cop d'ull. purple queda per a
  // woocommerce (color propi, sense cap altre ús a l'app); amber/orange/
  // yellow és la família càlida "acordada" dels 3 canals manuals elegibles
  // (whatsapp/telefon/correu) — mateix to, distingibles entre ells.
  purple: 'bg-purple-50 text-purple-700',
  amber: 'bg-amber-50 text-amber-700',
  orange: 'bg-orange-50 text-orange-700',
  yellow: 'bg-yellow-50 text-yellow-700',
  // Estat esborrany (tasca 33): vora discontínua, "encara no és definitiva".
  draft: 'border border-dashed border-gray-400 bg-white text-gray-600',
};

export function Badge({
  children,
  variant = 'neutral',
}: {
  children: ReactNode;
  variant?: BadgeVariant;
}) {
  return (
    <span
      className={`inline-block max-w-full rounded-md px-2.5 py-1 text-xs font-semibold break-words ${VARIANT_STYLES[variant]}`}
    >
      {children}
    </span>
  );
}
