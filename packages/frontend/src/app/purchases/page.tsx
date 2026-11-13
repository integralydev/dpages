'use client';

import { ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { PackagingFilterBar, usePackagingFilters } from '@/components/packaging/PackagingFilters';
import { PackagingCard, PackagingRow } from '@/components/packaging/PackagingLines';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { usePanellCompres } from '@/hooks/usePanellCompres';
import {
  type LliuramentSaveResult,
  type PackagingPanelFilters,
  usePanellEmpaquetat,
} from '@/hooks/usePanellEmpaquetat';
import type { FilaPanellCompresApi, FilaPanellEmpaquetatApi } from '@/lib/api';
import { formatDecimal } from '@/lib/decimals';

// Tasca 41 (Excel del client): la mateixa informació que el Panell
// Empaquetat (mateixos filtres, mateixes línies, mateixa edició d'unitats i
// quilos lliurats), però acumulada per client. Cada client es desplega amb
// la fletxa per veure i editar totes les línies que ha demanat.

/** Clau estable d'un grup: l'id del client, o 0 per a "Sense client". */
function clauGrup(grup: FilaPanellCompresApi): number {
  return grup.client?.id ?? 0;
}

function nomClient(grup: FilaPanellCompresApi): string {
  if (grup.client === null) return 'Sense client';
  return grup.client.nom ?? grup.client.codi ?? `Client ${grup.client.id}`;
}

function plural(quantitat: number, singular: string, pluralText: string): string {
  return `${quantitat} ${quantitat === 1 ? singular : pluralText}`;
}

function resumGrup(grup: FilaPanellCompresApi): string {
  return [
    plural(grup.comandes, 'comanda', 'comandes'),
    plural(grup.linies, 'línia', 'línies'),
    plural(grup.liniesConfirmades, 'enviada', 'enviades'),
  ].join(' · ');
}

function leftBorderClass(totEnviat: boolean) {
  return totEnviat ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-gray-200';
}

type UndoLliurament = (comandaId: number, liniaId: number) => Promise<LliuramentSaveResult>;
type OnRequestUndo = (line: FilaPanellEmpaquetatApi, undo: UndoLliurament) => void;

// Mateixes columnes que la taula del Panell Empaquetat, amb el número de
// comanda on allà hi ha el client (aquí el client ja és el grup).
const LINE_HEADERS: { label: string; className: string; ocult?: boolean }[] = [
  { label: 'Categoria', className: 'w-[7%] text-left' },
  // Columna de la casella: massa estreta per a un títol visible.
  { label: 'Enviada', className: 'hidden w-[4%] text-center xl:table-cell', ocult: true },
  { label: "Data d'expedició", className: 'hidden w-[7%] text-left xl:table-cell' },
  { label: 'Data de lliurament', className: 'hidden w-[7%] text-left xl:table-cell' },
  { label: 'Transportista', className: 'hidden w-[8%] text-left xl:table-cell' },
  { label: 'Producte', className: 'w-[11%] text-left' },
  { label: 'Comanda', className: 'w-[8%] text-left' },
  { label: 'Obs. empaquetat', className: 'w-[10%] text-left' },
  { label: 'Unitats demanades', className: 'w-[8%] text-right' },
  { label: 'Unitats lliurades', className: 'w-[8%] text-right' },
  { label: 'Kilos demanats', className: 'w-[7%] text-right' },
  { label: 'Kilos lliurats', className: 'w-[8%] text-right' },
  { label: 'Desar', className: 'w-[7%] text-center' },
];

/**
 * Les línies d'un client (o de les comandes sense client) amb els filtres
 * actius, editables igual que al Panell Empaquetat. Ordenades per comanda:
 * una línia no canvia de lloc en desar-la.
 */
function ClientLinies({
  filters,
  clientId,
  vista,
  onChanged,
  onRequestUndo,
}: {
  filters: PackagingPanelFilters;
  /** `null` = comandes sense client. */
  clientId: number | null;
  vista: 'taula' | 'targetes';
  /** S'ha desat o desfet una línia: cal refrescar els acumulats. */
  onChanged: () => void;
  onRequestUndo: OnRequestUndo;
}) {
  const { data, paginacio, setPagina, isLoading, error, saveLliurament, undoLliurament } =
    usePanellEmpaquetat({
      ...filters,
      ...(clientId === null ? { senseClient: 'si' as const } : { clientId }),
      ordre: 'comanda',
    });

  async function handleSave(
    comandaId: number,
    liniaId: number,
    unitatsLliurades: number,
    kgLliurats: string,
  ) {
    const result = await saveLliurament(comandaId, liniaId, { unitatsLliurades, kgLliurats });
    if (result.success) onChanged();
    return result;
  }

  const undo: UndoLliurament = async (comandaId, liniaId) => {
    const result = await undoLliurament(comandaId, liniaId);
    if (result.success) onChanged();
    return result;
  };
  const requestUndo = (line: FilaPanellEmpaquetatApi) => onRequestUndo(line, undo);

  // Només "Carregant..." la primera vegada: en desar una línia es refresquen
  // les dades sense amagar la taula, perquè la resta de files no perdin el
  // que s'hi estava escrivint.
  if (isLoading && data.length === 0) {
    return <p className="px-3 py-2 text-sm text-gray-500">Carregant...</p>;
  }
  if (error) {
    return (
      <p className="px-3 py-2 text-sm text-red-600">
        No s&apos;han pogut carregar les línies: {error.message}
      </p>
    );
  }

  // La clau inclou els valors desats: la fila que s'acaba de desar es torna
  // a muntar amb els valors del servidor (i "Desar" es desactiva); les
  // altres conserven el seu esborrany.
  const clauLinia = (line: FilaPanellEmpaquetatApi) =>
    `${line.liniaId}|${line.confirmatA ?? ''}|${line.unitatsLliurades}|${line.kgLliurats}`;

  const pagination = paginacio && paginacio.totalPagines > 1 && (
    <Pagination paginacio={paginacio} onPageChange={setPagina} />
  );

  if (vista === 'targetes') {
    return (
      <div className="flex flex-col gap-3">
        {data.map((line) => (
          <PackagingCard
            key={clauLinia(line)}
            line={line}
            onSave={handleSave}
            onRequestUndo={requestUndo}
            identificador="comanda"
          />
        ))}
        {pagination}
      </div>
    );
  }

  return (
    <>
      <table className="w-full table-fixed rounded-lg border border-gray-200 bg-white text-sm">
        <thead className="border-b border-gray-200">
          <tr>
            {LINE_HEADERS.map((header) => (
              <th
                key={header.label}
                className={`${header.className} px-3 py-2 font-medium text-gray-500 break-words`}
              >
                {header.ocult ? <span className="sr-only">{header.label}</span> : header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((line) => (
            <PackagingRow
              key={clauLinia(line)}
              line={line}
              onSave={handleSave}
              onRequestUndo={requestUndo}
              identificador="comanda"
            />
          ))}
        </tbody>
      </table>
      {pagination}
    </>
  );
}

export default function PurchasesPage() {
  const { filters, state: filterState } = usePackagingFilters();
  const {
    data: grups,
    totals,
    paginacio,
    setPagina,
    isLoading,
    error,
    refetch,
  } = usePanellCompres(filters);

  // Clients desplegats (per clau de grup). Es conserven en canviar filtres:
  // si el client segueix a la llista, segueix obert.
  const [oberts, setOberts] = useState<Set<number>>(new Set());
  function toggleObert(clau: number) {
    setOberts((actual) => {
      const nou = new Set(actual);
      if (nou.has(clau)) nou.delete(clau);
      else nou.add(clau);
      return nou;
    });
  }

  // Diàleg de "desfer" alçat a la pàgina (mateix patró que Empaquetat i
  // Obrador): un sol ConfirmDialog, no un per fila. Es guarda també la
  // funció de desfer del grup al qual pertany la línia.
  const [lineToUndo, setLineToUndo] = useState<{
    line: FilaPanellEmpaquetatApi;
    undo: UndoLliurament;
  } | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);

  const handleRequestUndo: OnRequestUndo = (line, undo) => {
    setUndoError(null);
    setLineToUndo({ line, undo });
  };

  async function handleConfirmUndo() {
    if (!lineToUndo) return;
    setIsUndoing(true);
    setUndoError(null);
    const result = await lineToUndo.undo(lineToUndo.line.comandaId, lineToUndo.line.liniaId);
    setIsUndoing(false);
    if (result.success) setLineToUndo(null);
    else setUndoError(result.generalError);
  }

  return (
    <div>
      <PageHeader
        title="Panell de Compres"
        subtitle="Línies de comanda acumulades per client. Desplega un client per editar el que se li ha enviat."
        right={
          <div className="flex flex-wrap gap-3">
            <StatCard
              label="TOTAL KG DEMANATS"
              value={formatDecimal(totals?.kgDemanats ?? null, 3)}
              secondary={`${formatDecimal(totals?.kgLliurats ?? null, 3)} kg lliurats`}
            />
            <StatCard
              label="CLIENTS"
              value={totals?.clients ?? 0}
              secondary={plural(totals?.comandes ?? 0, 'comanda', 'comandes')}
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
            No s&apos;han pogut carregar els clients: {error.message}
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
          {grups.length === 0 && (
            <p className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
              No hi ha cap línia amb aquests filtres.
            </p>
          )}

          <div className="flex flex-col gap-3 md:hidden">
            {grups.map((grup) => {
              const clau = clauGrup(grup);
              const obert = oberts.has(clau);
              return (
                <div key={clau} className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => toggleObert(clau)}
                    aria-expanded={obert}
                    className={`${leftBorderClass(grup.liniesConfirmades === grup.linies)} flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left`}
                  >
                    <ChevronRight
                      aria-hidden
                      className={`mt-1 h-4 w-4 shrink-0 text-gray-500 transition-transform ${obert ? 'rotate-90' : ''}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium tracking-wide text-gray-500 uppercase">
                        {grup.client?.codi ?? '—'}
                      </span>
                      <span className="block font-semibold text-gray-900">{nomClient(grup)}</span>
                      <span className="block text-xs text-gray-500">{resumGrup(grup)}</span>
                    </span>
                    <span className="shrink-0 text-right text-sm text-gray-900">
                      <span className="block">{formatDecimal(grup.unitatsDemanades, 2)} u.</span>
                      <span className="block">{formatDecimal(grup.kgDemanats, 3)} kg</span>
                      <span className="block text-xs text-gray-500">
                        {formatDecimal(grup.kgLliurats, 3)} kg lliurats
                      </span>
                    </span>
                  </button>
                  {obert && (
                    <div className="pl-4">
                      <ClientLinies
                        filters={filters}
                        clientId={grup.client?.id ?? null}
                        vista="targetes"
                        onChanged={refetch}
                        onRequestUndo={handleRequestUndo}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {grups.length > 0 && (
            <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
              <table className="w-full table-fixed text-sm">
                <thead className="border-b border-gray-200">
                  <tr>
                    <th className="w-[5%] px-3 py-2">
                      <span className="sr-only">Desplegar</span>
                    </th>
                    <th className="w-[12%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                      Codi
                    </th>
                    <th className="w-[35%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                      Client
                    </th>
                    <th className="w-[12%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Unitats demanades
                    </th>
                    <th className="w-[12%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Unitats lliurades
                    </th>
                    <th className="w-[12%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Kilos demanats
                    </th>
                    <th className="w-[12%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Kilos lliurats
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {grups.map((grup) => {
                    const clau = clauGrup(grup);
                    const obert = oberts.has(clau);
                    const nom = nomClient(grup);
                    return (
                      <Fragment key={clau}>
                        <tr
                          onClick={() => toggleObert(clau)}
                          className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
                        >
                          <td
                            className={`${leftBorderClass(grup.liniesConfirmades === grup.linies)} px-3 py-3 text-center`}
                          >
                            <button
                              type="button"
                              aria-expanded={obert}
                              aria-label={
                                obert
                                  ? `Plegar les línies de ${nom}`
                                  : `Desplegar les línies de ${nom}`
                              }
                              className="rounded p-1 text-gray-500 hover:bg-gray-100"
                            >
                              <ChevronRight
                                aria-hidden
                                className={`h-4 w-4 transition-transform ${obert ? 'rotate-90' : ''}`}
                              />
                            </button>
                          </td>
                          <td className="px-3 py-3 break-words text-gray-700">
                            {grup.client?.codi ?? '—'}
                          </td>
                          <td className="px-3 py-3 break-words">
                            <span className="block font-semibold text-gray-900">{nom}</span>
                            <span className="block text-xs text-gray-500">{resumGrup(grup)}</span>
                          </td>
                          <td className="px-3 py-3 text-right text-gray-900">
                            {formatDecimal(grup.unitatsDemanades, 2)}
                          </td>
                          <td className="px-3 py-3 text-right text-gray-900">
                            {formatDecimal(grup.unitatsLliurades, 2)}
                          </td>
                          <td className="px-3 py-3 text-right font-semibold text-gray-900">
                            {formatDecimal(grup.kgDemanats, 3)}
                          </td>
                          <td className="px-3 py-3 text-right font-semibold text-gray-900">
                            {formatDecimal(grup.kgLliurats, 3)}
                          </td>
                        </tr>
                        {obert && (
                          <tr className="border-b border-gray-100">
                            <td colSpan={7} className="bg-gray-50 px-3 py-3">
                              <ClientLinies
                                filters={filters}
                                clientId={grup.client?.id ?? null}
                                vista="taula"
                                onChanged={refetch}
                                onRequestUndo={handleRequestUndo}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {paginacio && paginacio.totalPagines > 1 && (
            <Pagination paginacio={paginacio} onPageChange={setPagina} />
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={lineToUndo !== null}
        title="Desfer confirmació"
        message="Vols desfer la confirmació d'aquesta línia? Les quantitats es mantindran, però la línia tornarà a estar pendent."
        confirmLabel="Desfer"
        confirmingLabel="Desfent..."
        onConfirm={handleConfirmUndo}
        onCancel={() => {
          setLineToUndo(null);
          setUndoError(null);
        }}
        errorMessage={undoError}
        isConfirming={isUndoing}
      />
    </div>
  );
}
