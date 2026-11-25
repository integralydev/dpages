'use client';

import { CheckCheck, ChevronRight, Printer } from 'lucide-react';
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
import {
  api,
  ApiError,
  obtenirTotesLesPagines,
  type FilaPanellCompresApi,
  type FilaPanellEmpaquetatApi,
  type PanellCompresApi,
  type PanellEmpaquetatApi,
} from '@/lib/api';
import { formatDecimal } from '@/lib/decimals';
import { descarregarPdfCompresAgrupat, descarregarPdfCompresDesglossat } from '@/lib/ordersPdf';

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
  const { filters, etiquetes, state: filterState } = usePackagingFilters();
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

  // Les línies dels clients desplegats es carreguen a part (ClientLinies):
  // després de «Marcar tot com a lliurat» es tornen a muntar amb aquesta
  // clau perquè mostrin les línies ja confirmades.
  const [versioLinies, setVersioLinies] = useState(0);

  // 25/11/2026 (Ari): la vedella s'envia des d'aquest panell. Com a
  // Empaquetat (tasca 51), confirma d'un cop totes les línies pendents dels
  // filtres actius, de tots els clients i no només de la pàgina visible,
  // amb les unitats i els quilos demanats. Mateix endpoint i mateixos
  // filtres que Empaquetat.
  const pendents = totals?.liniesPendents ?? 0;
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
      setVersioLinies((versio) => versio + 1);
    } catch (caught) {
      setMarkAllError(caught instanceof ApiError ? caught.message : "No s'han pogut marcar.");
    } finally {
      setIsMarkingAll(false);
    }
  }

  // Com «Imprimir llista desglossada / agrupada» d'Obrador: TOTS els
  // clients dels filtres actius (no només la pàgina visible). El desglossat
  // porta, sota cada client, totes les seves línies (enviades i pendents).
  const [isPrinting, setIsPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  async function handlePrint(desglossat: boolean) {
    if (!totals) return;
    setIsPrinting(true);
    setPrintError(null);
    try {
      const totsElsGrups = await obtenirTotesLesPagines((pagina) =>
        api.get<PanellCompresApi>('/panells/compres', { ...filters, mida: 200, pagina }),
      );
      if (!desglossat) {
        await descarregarPdfCompresAgrupat({ grups: totsElsGrups, totals, filtres: etiquetes });
        return;
      }
      const linies = await obtenirTotesLesPagines((pagina) =>
        api.get<PanellEmpaquetatApi>('/panells/empaquetat', {
          ...filters,
          ordre: 'comanda',
          mida: 200,
          pagina,
        }),
      );
      const liniesPerClient = new Map<number, FilaPanellEmpaquetatApi[]>();
      for (const linia of linies) {
        const clau = linia.clientId ?? 0;
        const delClient = liniesPerClient.get(clau) ?? [];
        delClient.push(linia);
        liniesPerClient.set(clau, delClient);
      }
      await descarregarPdfCompresDesglossat({
        grups: totsElsGrups,
        liniesPerClient,
        totals,
        filtres: etiquetes,
      });
    } catch (caught) {
      setPrintError(
        caught instanceof ApiError
          ? `No s'ha pogut generar el PDF: ${caught.message}`
          : "No s'ha pogut generar el PDF.",
      );
    } finally {
      setIsPrinting(false);
    }
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
            {/* Un sota l'altre, com a Obrador. */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setMarkAllError(null);
                  setMarkAllNotice(null);
                  setIsConfirmingMarkAll(true);
                }}
                disabled={isLoading || pendents === 0}
                className="flex items-center justify-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <CheckCheck className="h-4 w-4" />
                Marcar tot com a lliurat ({pendents})
              </button>
              <button
                type="button"
                onClick={() => handlePrint(true)}
                disabled={isLoading || isPrinting || grups.length === 0}
                className="flex items-center justify-center gap-2 rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Printer className="h-4 w-4" />
                Imprimir llista desglossada
              </button>
              <button
                type="button"
                onClick={() => handlePrint(false)}
                disabled={isLoading || isPrinting || grups.length === 0}
                className="flex items-center justify-center gap-2 rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Printer className="h-4 w-4" />
                Imprimir llista agrupada
              </button>
            </div>
          </div>
        }
      />

      {isPrinting && <p className="-mt-6 mb-6 text-sm text-gray-500">Generant PDF...</p>}
      {printError && <p className="-mt-6 mb-6 text-sm text-red-600">{printError}</p>}
      {markAllNotice && <p className="-mt-6 mb-6 text-sm text-green-700">{markAllNotice}</p>}

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
                        key={versioLinies}
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
                                key={versioLinies}
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
      <ConfirmDialog
        isOpen={isConfirmingMarkAll}
        title="Marcar tot com a lliurat"
        message={`Es marcaran com a enviades les ${pendents} línies pendents que compleixen els filtres actuals, de tots els clients (no només els de la pàgina visible), amb les unitats i els quilos demanats. Les que s'hagin enviat amb menys, desa-les abans una per una. Vols continuar?`}
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
