'use client';

import { useState } from 'react';
import { PackagingFilterBar, usePackagingFilters } from '@/components/packaging/PackagingFilters';
import { PackagingCard, PackagingRow } from '@/components/packaging/PackagingLines';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { usePanellEmpaquetat } from '@/hooks/usePanellEmpaquetat';
import type { FilaPanellEmpaquetatApi } from '@/lib/api';
import { formatDecimal } from '@/lib/decimals';

export default function PackagingPage() {
  // Filtres compartits amb el Panell de Compres (tasca 41).
  const { filters, state: filterState } = usePackagingFilters();

  // "pendents primer" ja ve per defecte des del backend (GET
  // /panells/empaquetat, ORDER BY confirmat_a IS NOT NULL ASC), sense cap
  // paràmetre — confirmat amb curl real abans de treure el sort
  // client-side que hi havia acá com a pedaç temporal.
  const {
    data,
    totals,
    paginacio,
    setPagina,
    isLoading,
    error,
    refetch,
    saveLliurament,
    undoLliurament,
  } = usePanellEmpaquetat(filters);

  // Issue #19 — estat del diàleg de confirmació de "desfer" alçat a la
  // pàgina (mateix patró que categories/page.tsx amb categoryToDelete): un
  // sol ConfirmDialog al final del JSX, no un per fila (Modal no fa
  // portal, un <div className="fixed..."> dins d'un <tr> seria HTML
  // invàlid).
  const [lineToUndo, setLineToUndo] = useState<FilaPanellEmpaquetatApi | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);

  function handleRequestUndo(line: FilaPanellEmpaquetatApi) {
    setUndoError(null);
    setLineToUndo(line);
  }

  function handleCancelUndo() {
    setLineToUndo(null);
    setUndoError(null);
  }

  async function handleConfirmUndo() {
    if (!lineToUndo) return;
    setIsUndoing(true);
    setUndoError(null);
    const result = await undoLliurament(lineToUndo.comandaId, lineToUndo.liniaId);
    setIsUndoing(false);
    if (result.success) {
      setLineToUndo(null);
    } else {
      setUndoError(result.generalError);
    }
  }

  async function handleSave(
    comandaId: number,
    liniaId: number,
    unitatsLliurades: number,
    kgLliurats: string,
  ) {
    return saveLliurament(comandaId, liniaId, { unitatsLliurades, kgLliurats });
  }

  return (
    <div>
      <PageHeader
        title="Panell d'Empaquetat"
        subtitle="Línies de comanda per a la planificació d'empaquetat."
        right={
          <div className="flex flex-wrap gap-3">
            <StatCard
              label="TOTAL UNITATS VISIBLES"
              value={formatDecimal(totals?.unitatsDemanades ?? null, 2)}
            />
            <StatCard
              label="TOTAL LÍNIES"
              value={totals?.linies ?? 0}
              secondary={`${totals?.liniesConfirmades ?? 0} confirmades · ${totals?.liniesPendents ?? 0} pendents`}
            />
          </div>
        }
      />

      <PackagingFilterBar state={filterState} />

      {isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;han pogut carregar les línies: {error.message}
          </p>
          <button
            type="button"
            onClick={refetch}
            className="shrink-0 rounded-full border border-red-300 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            Torna-ho a provar
          </button>
        </div>
      )}

      {!isLoading && !error && (
        <>
          <div className="flex flex-col gap-3 md:hidden">
            {data.map((line) => (
              <PackagingCard
                key={line.liniaId}
                line={line}
                onSave={handleSave}
                onRequestUndo={handleRequestUndo}
              />
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[7%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Categoria
                  </th>
                  <th className="hidden w-[4%] px-3 py-2 text-center font-medium text-gray-500 break-words xl:table-cell">
                    <span className="sr-only">Treballada</span>
                  </th>
                  <th className="hidden w-[7%] px-3 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Data d&apos;expedició
                  </th>
                  <th className="hidden w-[7%] px-3 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Data de lliurament
                  </th>
                  <th className="hidden w-[8%] px-3 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Transportista
                  </th>
                  <th className="w-[11%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Producte
                  </th>
                  <th className="hidden w-[8%] px-3 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Client
                  </th>
                  <th className="w-[10%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Obs. empaquetat
                  </th>
                  <th className="w-[8%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Unitats demanades
                  </th>
                  <th className="w-[8%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Unitats lliurades
                  </th>
                  <th className="w-[7%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Kilos demanats
                  </th>
                  <th className="w-[8%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Kilos lliurats
                  </th>
                  <th className="w-[7%] px-3 py-2 text-center font-medium text-gray-500 break-words">
                    Desar
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((line) => (
                  <PackagingRow
                    key={line.liniaId}
                    line={line}
                    onSave={handleSave}
                    onRequestUndo={handleRequestUndo}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {paginacio && <Pagination paginacio={paginacio} onPageChange={setPagina} />}
        </>
      )}

      <ConfirmDialog
        isOpen={lineToUndo !== null}
        title="Desfer confirmació"
        message="Vols desfer la confirmació d'aquesta línia? Les quantitats es mantindran, però la línia tornarà a estar pendent."
        confirmLabel="Desfer"
        confirmingLabel="Desfent..."
        onConfirm={handleConfirmUndo}
        onCancel={handleCancelUndo}
        errorMessage={undoError}
        isConfirming={isUndoing}
      />
    </div>
  );
}
