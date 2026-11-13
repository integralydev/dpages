'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Paginacio } from '@/lib/api';
import { formatNombre } from '@/lib/decimals';

const BUTTON_CLASS =
  'flex items-center justify-center gap-1.5 rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent';

/**
 * Consumeix directe el `Paginacio` que ja devolen els 8+ endpoints
 * paginats del backend ({ pagina, mida, total, totalPagines }) — cap shape
 * propi. No renderitza res si `totalPagines <= 1` (llistes curtes no
 * guanyen res mostrant controls sempre deshabilitats).
 */
export function Pagination({
  paginacio,
  onPageChange,
}: {
  paginacio: Paginacio;
  onPageChange: (pagina: number) => void;
}) {
  const { pagina, mida, total, totalPagines } = paginacio;
  if (totalPagines <= 1) return null;

  const desde = (pagina - 1) * mida + 1;
  const fins = Math.min(pagina * mida, total);
  const canGoPrev = pagina > 1;
  const canGoNext = pagina < totalPagines;
  const indicator = `${formatNombre(desde)}-${formatNombre(fins)} de ${formatNombre(total)}`;

  return (
    <div className="mt-4">
      {/* Desktop/tablet: Anterior — indicador — Següent en una sola fila. */}
      <div className="hidden items-center justify-between sm:flex">
        <button
          type="button"
          onClick={() => onPageChange(pagina - 1)}
          disabled={!canGoPrev}
          className={BUTTON_CLASS}
        >
          <ChevronLeft className="h-4 w-4" />
          Anterior
        </button>
        <p className="text-sm text-gray-500">{indicator}</p>
        <button
          type="button"
          onClick={() => onPageChange(pagina + 1)}
          disabled={!canGoNext}
          className={BUTTON_CLASS}
        >
          Següent
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Mobile (320px): no entren els tres elements en una fila (auditoria
          de responsive) — indicador arriba, botons a ample complet abaix,
          mateix patró que DataCardActions. */}
      <div className="flex flex-col items-center gap-3 sm:hidden">
        <p className="text-sm text-gray-500">{indicator}</p>
        <div className="flex w-full gap-2">
          <button
            type="button"
            onClick={() => onPageChange(pagina - 1)}
            disabled={!canGoPrev}
            className={`flex-1 ${BUTTON_CLASS}`}
          >
            <ChevronLeft className="h-4 w-4" />
            Anterior
          </button>
          <button
            type="button"
            onClick={() => onPageChange(pagina + 1)}
            disabled={!canGoNext}
            className={`flex-1 ${BUTTON_CLASS}`}
          >
            Següent
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
