'use client';

import { useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { PackagingFilterBar, usePackagingFilters } from '@/components/packaging/PackagingFilters';
import { PackagingCard, PackagingRow } from '@/components/packaging/PackagingLines';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { usePanellEmpaquetat } from '@/hooks/usePanellEmpaquetat';
import { api, ApiError, type FilaPanellEmpaquetatApi } from '@/lib/api';
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

  // Tasca 51 (Ari, 17/11/2026): com «Marcar totes com a fetes» d'Obrador,
  // confirma d'un cop totes les línies pendents dels filtres actius amb les
  // unitats i els quilos demanats. Les enviades amb menys (mermes) s'han de
  // desar abans una per una; el diàleg ho recorda.
  const pendents = totals?.liniesPendents ?? 0;
  // El backend exigeix almenys una data (d'expedició o de lliurament): sense,
  // es marcarien totes les pendents del sistema.
  const ambFiltreData = Boolean(
    filters.dataExpedicioDes ||
    filters.dataExpedicioFins ||
    filters.dataLliuramentDes ||
    filters.dataLliuramentFins,
  );
  const [isConfirmingMarkAll, setIsConfirmingMarkAll] = useState(false);
  const [isMarkingAll, setIsMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const [markAllNotice, setMarkAllNotice] = useState<string | null>(null);

  async function handleConfirmMarkAll() {
    setIsMarkingAll(true);
    setMarkAllError(null);
    try {
      // `confirmacio` no aplica: l'acció ja només toca les pendents.
      const filtresAccio = { ...filters };
      delete filtresAccio.confirmacio;
      const resposta = await api.post<{ marcades: number; congeladesOmeses: number }>(
        '/panells/empaquetat/marcar-lliurades',
        {},
        filtresAccio,
      );
      setIsConfirmingMarkAll(false);
      setMarkAllNotice(
        resposta.congeladesOmeses > 0
          ? `${resposta.marcades} línies marcades com a enviades. ${resposta.congeladesOmeses} no s'han pogut marcar perquè la comanda està congelada.`
          : `${resposta.marcades} línies marcades com a enviades.`,
      );
      refetch();
    } catch (caught) {
      setMarkAllError(caught instanceof ApiError ? caught.message : "No s'han pogut marcar.");
    } finally {
      setIsMarkingAll(false);
    }
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
            <button
              type="button"
              onClick={() => {
                setMarkAllError(null);
                setMarkAllNotice(null);
                setIsConfirmingMarkAll(true);
              }}
              disabled={isLoading || pendents === 0 || !ambFiltreData}
              title={
                ambFiltreData
                  ? undefined
                  : "Filtra per data d'expedició o de lliurament per poder marcar-ho tot"
              }
              className="flex items-center justify-center gap-2 self-center rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CheckCheck className="h-4 w-4" />
              Marcar tot com a lliurat ({pendents})
            </button>
          </div>
        }
      />

      {markAllNotice && <p className="-mt-6 mb-6 text-sm text-green-700">{markAllNotice}</p>}
      {!ambFiltreData && pendents > 0 && (
        <p className="-mt-6 mb-6 text-sm text-gray-500">
          Per marcar-ho tot com a lliurat, filtra per data d&apos;expedició o de lliurament.
        </p>
      )}

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
      <ConfirmDialog
        isOpen={isConfirmingMarkAll}
        title="Marcar tot com a lliurat"
        message={`Es marcaran com a enviades les ${pendents} línies pendents que compleixen els filtres actuals (no només les de la pàgina visible), amb les unitats i els quilos demanats. Les que s'hagin enviat amb menys, desa-les abans una per una. Vols continuar?`}
        confirmLabel="Marcar tot"
        confirmingLabel="Marcant..."
        onConfirm={handleConfirmMarkAll}
        onCancel={() => setIsConfirmingMarkAll(false)}
        errorMessage={markAllError}
        isConfirming={isMarkingAll}
      />
    </div>
  );
}
