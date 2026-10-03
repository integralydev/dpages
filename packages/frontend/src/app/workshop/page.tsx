'use client';

import { Fragment, useMemo, useState } from 'react';
import { CheckCheck, ChevronRight, Printer } from 'lucide-react';
import { AsyncCombobox, type ComboboxOption } from '@/components/ui/AsyncCombobox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ClearFiltersButton, FilterBar } from '@/components/ui/FilterBar';
import { MultiCombobox } from '@/components/ui/MultiCombobox';
import { DataCard, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { DateInput } from '@/components/ui/DateInput';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { StatCard } from '@/components/ui/StatCard';
import { useCatalog } from '@/hooks/useCatalog';
import { useCategories } from '@/hooks/useCategories';
import {
  type MarcarTotesResult,
  type ToggleTreballResult,
  usePanellObrador,
  type WorkshopPanelFilters,
} from '@/hooks/usePanellObrador';
import { usePanellObradorAcumulat } from '@/hooks/usePanellObradorAcumulat';
import {
  api,
  ApiError,
  type ClientApi,
  type FilaPanellObradorAcumulatApi,
  type FilaPanellObradorApi,
  obtenirTotesLesPagines,
  type PanellObradorApi,
  type RespostaPaginada,
} from '@/lib/api';
import { formatData } from '@/lib/dates';
import { formatDecimal } from '@/lib/decimals';
import { descarregarPdfObradorNoFetes } from '@/lib/ordersPdf';
import { MAX_LOCAL_COMBOBOX_RESULTS, matchesProductQuery } from '@/lib/productSearch';

const ALL = 'Tots';
const ALL_FEM = 'Totes';

// Valors fixos del enum real (ProducteApi.format/envasat, contrato §4.2) —
// filtres exactes contra el backend, no es deriven de `data` perquè són un
// conjunt tancat conegut, no un catàleg lliure.
const FORMAT_OPTIONS = ['SENCER', 'TALLAT', 'LLESCAT'];
const ENVASAT_OPTIONS = ['NORMAL', 'NORMAL (pes)', 'NORMAL (web)', 'ESPECIAL'];

// Tasca 31: amb / sense observacions de producció de la línia.
const OBSERVACIONS_OPTIONS = { 'Amb observacions': 'si', 'Sense observacions': 'no' } as const;
// Tasca 26: línies pendents o ja fetes.
const TREBALL_OPTIONS = { Pendents: 'pendents', Fetes: 'fets' } as const;

// Tasca 25: mateix cercador de clients que Empaquetat i Oficina
// (GET /clients?cerca=, mode servidor).
async function loadClientOptions(query: string): Promise<ComboboxOption[]> {
  const resposta = await api.get<RespostaPaginada<ClientApi>>('/clients', {
    cerca: query,
    mida: 8,
  });
  return resposta.dades.map((client) => ({
    id: client.id,
    label: `${client.codi ?? client.id} · ${client.nom ?? ''}`,
  }));
}

function leftBorderClass(treballat: boolean) {
  return treballat ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-gray-200';
}

/**
 * A diferència del checkbox de sòl lectura d'Empaquetat
 * (`WorkedCheckbox`, packaging/page.tsx), aquest SÍ dispara la crida real:
 * el propi click és l'acció, sense formulari ni botó "Guardar" separat.
 * Estat optimista local: es marca a l'instant i es desactiva mentre la
 * crida està en curs; si falla, torna a l'últim valor confirmat pel
 * servidor (`treballatA`, mai tocat mentre la crida falla) i mostra
 * l'error just sota el checkbox d'aquesta fila, no de tota la pantalla.
 *
 * Consistència amb Empaquetat (WorkedCheckbox, packaging/page.tsx) — aquest
 * hook ja NOMÉS gestiona el sentit "marcar" (pendent → treballada): el
 * sentit "desmarcar" ja no és instantani, requereix el ConfirmDialog alçat
 * a la pàgina (mateix patró que "desfer" a Empaquetat) abans de cridar
 * `onToggle(..., false)`.
 */
function useTreballToggle(
  comandaId: number,
  liniaId: number,
  treballatA: string | null,
  onToggle: (comandaId: number, liniaId: number, marcat: boolean) => Promise<ToggleTreballResult>,
) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checked = pending ?? treballatA !== null;

  async function markAsDone() {
    setPending(true);
    setIsToggling(true);
    setError(null);
    const result = await onToggle(comandaId, liniaId, true);
    setIsToggling(false);
    setPending(null);
    if (!result.success) setError(result.error);
  }

  return { checked, isToggling, error, markAsDone };
}

function TreballCheckbox({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={checked ? 'Desmarcar línia treballada' : 'Marcar com a treballada'}
      className="h-4 w-4 rounded border-gray-300 text-ink disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
}

function WorkshopCard({
  line,
  onToggle,
  onRequestUnmark,
}: {
  line: FilaPanellObradorApi;
  onToggle: (comandaId: number, liniaId: number, marcat: boolean) => Promise<ToggleTreballResult>;
  onRequestUnmark: (line: FilaPanellObradorApi) => void;
}) {
  const { checked, isToggling, error, markAsDone } = useTreballToggle(
    line.comandaId,
    line.liniaId,
    line.treballatA,
    onToggle,
  );

  function handleChange() {
    if (checked) {
      onRequestUnmark(line);
    } else {
      markAsDone();
    }
  }

  return (
    <div className="relative overflow-hidden rounded-xl">
      <div
        className={`absolute inset-y-0 left-0 w-1 ${checked ? 'bg-green-500' : 'bg-gray-200'}`}
      />
      <DataCard>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
              {line.agrupacioProduccio ?? '—'}
            </p>
            <p className="font-semibold text-gray-900">{line.producte.descripcio}</p>
            <p className="text-sm text-gray-500">{line.client ?? '—'}</p>
          </div>
          <TreballCheckbox checked={checked} disabled={isToggling} onChange={handleChange} />
        </div>

        <div className="mt-3">
          <DataCardGrid>
            <DataCardField label="Envasat">{line.envasat ?? '—'}</DataCardField>
            <DataCardField label="Format">{line.format ?? '—'}</DataCardField>
            <DataCardField label="Data producció">
              {line.dataProduccio ? formatData(line.dataProduccio, false) : '—'}
            </DataCardField>
            <DataCardField label="Unitats">{formatDecimal(line.unitats, 2)}</DataCardField>
            <DataCardField label="Pes (kg)">{formatDecimal(line.kg, 3)}</DataCardField>
          </DataCardGrid>
        </div>

        {line.obsProduccio && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <DataCardField label="Obs. producció">{line.obsProduccio}</DataCardField>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </DataCard>
    </div>
  );
}

function WorkshopRow({
  line,
  onToggle,
  onRequestUnmark,
}: {
  line: FilaPanellObradorApi;
  onToggle: (comandaId: number, liniaId: number, marcat: boolean) => Promise<ToggleTreballResult>;
  onRequestUnmark: (line: FilaPanellObradorApi) => void;
}) {
  const { checked, isToggling, error, markAsDone } = useTreballToggle(
    line.comandaId,
    line.liniaId,
    line.treballatA,
    onToggle,
  );

  function handleChange() {
    if (checked) {
      onRequestUnmark(line);
    } else {
      markAsDone();
    }
  }

  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className={`${leftBorderClass(checked)} px-3 py-3 text-center`}>
        <TreballCheckbox checked={checked} disabled={isToggling} onChange={handleChange} />
        {error && <p className="mt-1 max-w-[100px] text-xs text-red-600">{error}</p>}
      </td>
      <td className="px-3 py-3 break-words text-gray-700">{line.agrupacioProduccio ?? '—'}</td>
      <td className="px-3 py-3 break-words">
        <span className="font-semibold text-gray-900">{line.producte.descripcio}</span>
      </td>
      <td className="px-3 py-3 break-words text-gray-900">{line.envasat ?? '—'}</td>
      <td className="px-3 py-3 break-words text-gray-900">{line.format ?? '—'}</td>
      <td className="px-3 py-3 break-words text-gray-900">{line.client ?? '—'}</td>
      <td className="px-3 py-3 break-words text-gray-900">
        {line.dataProduccio ? formatData(line.dataProduccio, false) : '—'}
      </td>
      <td className="px-3 py-3 text-right text-gray-900">{formatDecimal(line.unitats, 2)}</td>
      <td className="px-3 py-3 text-right text-gray-900">{formatDecimal(line.kg, 3)}</td>
      <td className="px-3 py-3 break-words text-gray-900">{line.obsProduccio ?? ''}</td>
    </tr>
  );
}

type OnToggle = (
  comandaId: number,
  liniaId: number,
  marcat: boolean,
) => Promise<ToggleTreballResult>;
type OnRequestUnmark = (line: FilaPanellObradorApi, toggle: OnToggle) => void;

const LINE_HEADERS: { label: string; className: string }[] = [
  { label: 'Agrupació producció', className: 'w-[10%] text-left' },
  { label: 'Producte', className: 'w-[14%] text-left' },
  { label: 'Envasat', className: 'w-[10%] text-left' },
  { label: 'Format', className: 'w-[8%] text-left' },
  { label: 'Client', className: 'w-[12%] text-left' },
  { label: 'Data producció', className: 'w-[10%] text-left' },
  { label: 'Unitats', className: 'w-[8%] text-right' },
  { label: 'Pes (kg)', className: 'w-[9%] text-right' },
  { label: 'Obs. producció', className: 'w-[14%] text-left' },
];

/**
 * Tasca 29: les línies d'un producte quan se'n desplega la fila acumulada.
 * Es demanen amb els mateixos filtres que la vista acumulada (més
 * `producteId`), així que mai hi surten línies que no els compleixin.
 */
function ProducteLinies({
  filters,
  producteId,
  vista,
  onChanged,
  onRequestUnmark,
}: {
  filters: WorkshopPanelFilters;
  producteId: number;
  vista: 'taula' | 'targetes';
  /** Una línia s'ha marcat o desmarcat: cal refrescar els acumulats. */
  onChanged: () => void;
  onRequestUnmark: OnRequestUnmark;
}) {
  const { data, paginacio, setPagina, isLoading, error, toggleTreball } = usePanellObrador({
    ...filters,
    producteId,
  });

  const onToggle: OnToggle = async (comandaId, liniaId, marcat) => {
    const result = await toggleTreball(comandaId, liniaId, marcat);
    if (result.success) onChanged();
    return result;
  };
  const requestUnmark = (line: FilaPanellObradorApi) => onRequestUnmark(line, onToggle);

  if (isLoading) return <p className="px-3 py-2 text-sm text-gray-500">Carregant...</p>;
  if (error) {
    return (
      <p className="px-3 py-2 text-sm text-red-600">
        No s&apos;han pogut carregar les línies: {error.message}
      </p>
    );
  }

  const pagination = paginacio && paginacio.totalPagines > 1 && (
    <Pagination paginacio={paginacio} onPageChange={setPagina} />
  );

  if (vista === 'targetes') {
    return (
      <div className="flex flex-col gap-3">
        {data.map((line) => (
          <WorkshopCard
            key={line.liniaId}
            line={line}
            onToggle={onToggle}
            onRequestUnmark={requestUnmark}
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
            <th className="w-[5%] px-3 py-2">
              <span className="sr-only">Treballada</span>
            </th>
            {LINE_HEADERS.map((header) => (
              <th
                key={header.label}
                className={`${header.className} px-3 py-2 font-medium text-gray-500 break-words`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((line) => (
            <WorkshopRow
              key={line.liniaId}
              line={line}
              onToggle={onToggle}
              onRequestUnmark={requestUnmark}
            />
          ))}
        </tbody>
      </table>
      {pagination}
    </>
  );
}

function liniesFetesText(grup: FilaPanellObradorAcumulatApi): string {
  return `${grup.linies} ${grup.linies === 1 ? 'línia' : 'línies'} · ${grup.liniesFetes} ${grup.liniesFetes === 1 ? 'feta' : 'fetes'}`;
}

export default function WorkshopPage() {
  const { data: catalog } = useCatalog();

  // Un o més productes (petició del client, 29/09/2026) — es guarda
  // l'opció sencera (id+label) per poder pintar l'etiqueta de cadascun.
  const [selectedProducts, setSelectedProducts] = useState<ComboboxOption[]>([]);
  // Tasca 24 (01/10/2026): mateix filtre que al Panell Empaquetat.
  const { data: categories } = useCategories();
  const [categoryFilter, setCategoryFilter] = useState(ALL_FEM);
  const categoriaId = useMemo(
    () =>
      categoryFilter !== ALL_FEM
        ? categories.find((item) => item.nom === categoryFilter)?.id
        : undefined,
    [categoryFilter, categories],
  );
  // Tasca 28: agrupacions de producció del catàleg, sense repetir i
  // ordenades; l'id només serveix per al MultiCombobox.
  const [selectedAgrupacions, setSelectedAgrupacions] = useState<ComboboxOption[]>([]);
  const agrupacions = useMemo(
    () =>
      Array.from(
        new Set(
          catalog
            .map((product) => product.agrupacioProduccio)
            .filter((value): value is string => !!value),
        ),
      ).sort((a, b) => a.localeCompare(b, 'ca')),
    [catalog],
  );
  const loadAgrupacioOptions = useMemo(
    () => (query: string) =>
      Promise.resolve(
        agrupacions
          .map((nom, index) => ({ id: index + 1, label: nom }))
          .filter((option) => option.label.toLowerCase().startsWith(query.toLowerCase())),
      ),
    [agrupacions],
  );
  const [selectedClient, setSelectedClient] = useState<ComboboxOption | null>(null);
  const [observacionsFilter, setObservacionsFilter] = useState(ALL_FEM);
  const [treballFilter, setTreballFilter] = useState(ALL_FEM);
  const [envasatFilter, setEnvasatFilter] = useState(ALL);
  const [formatFilter, setFormatFilter] = useState(ALL);
  const [productionDateFilter, setProductionDateFilter] = useState('');

  // Mode LOCAL (filtrant `catalog` ja carregat), mateix criteri que
  // Producte a OrderForm.tsx — ver lib/productSearch.ts.
  const loadProductOptions = useMemo(
    () => (query: string) =>
      Promise.resolve(
        catalog
          .filter((product) => matchesProductQuery(product, query))
          .slice(0, MAX_LOCAL_COMBOBOX_RESULTS)
          .map((product) => ({ id: product.id, label: product.descripcio })),
      ),
    [catalog],
  );

  const filters = useMemo(
    () => ({
      ...(selectedAgrupacions.length > 0
        ? { agrupacioProduccio: selectedAgrupacions.map((item) => item.label) }
        : {}),
      ...(selectedClient !== null ? { clientId: selectedClient.id } : {}),
      ...(observacionsFilter !== ALL_FEM
        ? {
            observacions:
              OBSERVACIONS_OPTIONS[observacionsFilter as keyof typeof OBSERVACIONS_OPTIONS],
          }
        : {}),
      ...(treballFilter !== ALL_FEM
        ? { treball: TREBALL_OPTIONS[treballFilter as keyof typeof TREBALL_OPTIONS] }
        : {}),
      ...(categoriaId !== undefined ? { categoriaId } : {}),
      ...(selectedProducts.length > 0
        ? { producte: selectedProducts.map((product) => product.label) }
        : {}),
      ...(envasatFilter !== ALL ? { envasat: envasatFilter } : {}),
      ...(formatFilter !== ALL ? { format: formatFilter } : {}),
      ...(productionDateFilter
        ? { dataProduccioDes: productionDateFilter, dataProduccioFins: productionDateFilter }
        : {}),
    }),
    [
      selectedAgrupacions,
      selectedClient,
      observacionsFilter,
      treballFilter,
      categoriaId,
      selectedProducts,
      envasatFilter,
      formatFilter,
      productionDateFilter,
    ],
  );

  // "pendents primer" ja ve per defecte des del backend (GET
  // /panells/obrador, ORDER BY treballat_a IS NOT NULL ASC), sense cap
  // paràmetre — confirmat amb curl real abans de treure el sort client-side
  // que hi havia acá com a pedaç temporal.
  // Tasca 29: per defecte, una fila per producte; la fletxa en desplega
  // les línies (que es carreguen amb els mateixos filtres).
  const { data: grups, totals, isLoading, error, refetch } = usePanellObradorAcumulat(filters);
  const [obertes, setObertes] = useState<Set<number>>(() => new Set());
  // Canvia després de "marcar totes": les files obertes es tornen a carregar.
  const [versio, setVersio] = useState(0);

  function toggleObert(producteId: number) {
    setObertes((actual) => {
      const nova = new Set(actual);
      if (nova.has(producteId)) nova.delete(producteId);
      else nova.add(producteId);
      return nova;
    });
  }

  // Tasca 26: marca com a fetes totes les pendents dels filtres actius.
  async function marcarTotesFetes(): Promise<MarcarTotesResult> {
    try {
      // `treball` no aplica: l'acció ja només toca les pendents.
      const filtresAccio = { ...filters };
      delete filtresAccio.treball;
      const resposta = await api.post<{ marcades: number; congeladesOmeses: number }>(
        '/panells/obrador/marcar-fets',
        {},
        filtresAccio,
      );
      refetch();
      setVersio((actual) => actual + 1);
      return { success: true, ...resposta };
    } catch (caught) {
      const missatge = caught instanceof ApiError ? caught.message : "No s'han pogut marcar.";
      return { success: false, error: missatge };
    }
  }

  // Tasca 26: marcar totes les pendents dels filtres actius, amb confirmació.
  const [isConfirmingMarkAll, setIsConfirmingMarkAll] = useState(false);
  const [isMarkingAll, setIsMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const [markAllNotice, setMarkAllNotice] = useState<string | null>(null);
  const pendents = totals?.liniesPendents ?? 0;

  async function handleConfirmMarkAll() {
    setIsMarkingAll(true);
    setMarkAllError(null);
    const result = await marcarTotesFetes();
    setIsMarkingAll(false);
    if (!result.success) {
      setMarkAllError(result.error);
      return;
    }
    setIsConfirmingMarkAll(false);
    setMarkAllNotice(
      result.congeladesOmeses > 0
        ? `${result.marcades} línies marcades com a fetes. ${result.congeladesOmeses} no s'han pogut marcar perquè la comanda està congelada.`
        : `${result.marcades} línies marcades com a fetes.`,
    );
  }

  // Tasca 27: llistat en PDF de TOTES les línies no fetes que compleixen la
  // resta de filtres actius (no només la pàgina visible). El filtre de
  // "Fetes/Pendents" de pantalla no hi compta: sempre surten les pendents.
  const [isPrinting, setIsPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  async function handlePrintPending() {
    setIsPrinting(true);
    setPrintError(null);
    try {
      const linies = await obtenirTotesLesPagines((pagina) =>
        api.get<PanellObradorApi>('/panells/obrador', {
          ...filters,
          treball: 'pendents',
          mida: 200,
          pagina,
        }),
      );
      const etiquetes = [
        selectedAgrupacions.length > 0 &&
          `Agrupació: ${selectedAgrupacions.map((item) => item.label).join(', ')}`,
        categoryFilter !== ALL_FEM && `Categoria: ${categoryFilter}`,
        selectedProducts.length > 0 &&
          `Productes: ${selectedProducts.map((item) => item.label).join(', ')}`,
        selectedClient && `Client: ${selectedClient.label}`,
        observacionsFilter !== ALL_FEM && observacionsFilter,
        envasatFilter !== ALL && `Envasat: ${envasatFilter}`,
        formatFilter !== ALL && `Format: ${formatFilter}`,
        productionDateFilter && `Data producció: ${formatData(productionDateFilter, false)}`,
      ].filter((etiqueta): etiqueta is string => Boolean(etiqueta));
      await descarregarPdfObradorNoFetes({ linies, filtres: etiquetes });
    } catch (caught) {
      setPrintError(
        caught instanceof ApiError
          ? `No s'ha pogut generar el llistat: ${caught.message}`
          : "No s'ha pogut generar el llistat.",
      );
    } finally {
      setIsPrinting(false);
    }
  }

  // Consistència amb Empaquetat (lineToUndo, packaging/page.tsx) — mateix
  // patró: estat del diàleg alçat a la pàgina, un sol ConfirmDialog al
  // final del JSX en comptes d'un per fila.
  const [lineToUnmark, setLineToUnmark] = useState<{
    line: FilaPanellObradorApi;
    toggle: OnToggle;
  } | null>(null);
  const [unmarkError, setUnmarkError] = useState<string | null>(null);
  const [isUnmarking, setIsUnmarking] = useState(false);

  const handleRequestUnmark: OnRequestUnmark = (line, toggle) => {
    setUnmarkError(null);
    setLineToUnmark({ line, toggle });
  };

  function handleCancelUnmark() {
    setLineToUnmark(null);
    setUnmarkError(null);
  }

  async function handleConfirmUnmark() {
    if (!lineToUnmark) return;
    setIsUnmarking(true);
    setUnmarkError(null);
    const { line, toggle } = lineToUnmark;
    const result = await toggle(line.comandaId, line.liniaId, false);
    setIsUnmarking(false);
    if (result.success) {
      setLineToUnmark(null);
    } else {
      setUnmarkError(result.error);
    }
  }

  function clearFilters() {
    setSelectedAgrupacions([]);
    setSelectedClient(null);
    setObservacionsFilter(ALL_FEM);
    setTreballFilter(ALL_FEM);
    setSelectedProducts([]);
    setCategoryFilter(ALL_FEM);
    setEnvasatFilter(ALL);
    setFormatFilter(ALL);
    setProductionDateFilter('');
  }

  return (
    <div>
      <PageHeader
        title="Panell d'Obrador"
        subtitle="Línies de comanda per a la planificació d'obrador."
        right={
          <div className="flex flex-wrap gap-3">
            <StatCard
              label="TOTAL KG VISIBLES"
              value={formatDecimal(totals?.totalKg ?? null, 3)}
              secondary={`${formatDecimal(totals?.totalUnitats ?? null, 2)} unitats`}
            />
            <StatCard
              label="TOTAL LÍNIES"
              value={totals?.linies ?? 0}
              secondary={`${totals?.liniesFetes ?? 0} fetes · ${pendents} pendents`}
            />
            <button
              type="button"
              onClick={() => {
                setMarkAllError(null);
                setMarkAllNotice(null);
                setIsConfirmingMarkAll(true);
              }}
              disabled={isLoading || pendents === 0}
              className="flex items-center gap-2 self-center rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CheckCheck className="h-4 w-4" />
              Marcar totes com a fetes ({pendents})
            </button>
            <button
              type="button"
              onClick={handlePrintPending}
              disabled={isLoading || isPrinting}
              className="flex items-center gap-2 self-center rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Printer className="h-4 w-4" />
              {isPrinting ? 'Generant PDF...' : 'Imprimir no fetes'}
            </button>
          </div>
        }
      />
      {printError && <p className="-mt-6 mb-6 text-sm text-red-600">{printError}</p>}
      {markAllNotice && (
        <p className="-mt-6 mb-6 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {markAllNotice}
        </p>
      )}

      <FilterBar>
        {/* Tasca 28: primer filtre de tots, selecció múltiple. */}
        <MultiCombobox
          label="Agrupació producció"
          selected={selectedAgrupacions}
          onChange={setSelectedAgrupacions}
          placeholder="Cercar agrupació..."
          addMorePlaceholder="Afegir una altra agrupació..."
          debounceMs={0}
          loadOptions={loadAgrupacioOptions}
        />
        <SimpleDropdown
          label="Categoria"
          options={categories.map((item) => item.nom)}
          value={categoryFilter}
          onChange={setCategoryFilter}
          allLabel={ALL_FEM}
        />
        <MultiCombobox
          label="Productes"
          selected={selectedProducts}
          onChange={setSelectedProducts}
          placeholder="Cercar producte..."
          addMorePlaceholder="Afegir un altre producte..."
          debounceMs={0}
          loadOptions={loadProductOptions}
        />
        <AsyncCombobox
          label="Client"
          value={selectedClient?.id ?? null}
          displayValue={selectedClient?.label ?? ''}
          placeholder="Cercar client..."
          onChange={setSelectedClient}
          loadOptions={loadClientOptions}
        />
        <SimpleDropdown
          label="Envasat"
          options={ENVASAT_OPTIONS}
          value={envasatFilter}
          onChange={setEnvasatFilter}
          allLabel={ALL}
        />
        <SimpleDropdown
          label="Format"
          options={FORMAT_OPTIONS}
          value={formatFilter}
          onChange={setFormatFilter}
          allLabel={ALL}
        />
        <DateInput
          label="Data de producció"
          value={productionDateFilter}
          onChange={setProductionDateFilter}
        />
        <SimpleDropdown
          label="Observacions"
          options={Object.keys(OBSERVACIONS_OPTIONS)}
          value={observacionsFilter}
          onChange={setObservacionsFilter}
          allLabel={ALL_FEM}
        />
        <SimpleDropdown
          label="Estat línia"
          options={Object.keys(TREBALL_OPTIONS)}
          value={treballFilter}
          onChange={setTreballFilter}
          allLabel={ALL_FEM}
        />
        <ClearFiltersButton onClick={clearFilters} />
      </FilterBar>

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
          {grups.length === 0 && (
            <p className="text-sm text-gray-500">Cap línia compleix els filtres.</p>
          )}

          <div className="flex flex-col gap-3 md:hidden">
            {grups.map((grup) => {
              const oberta = obertes.has(grup.producte.id);
              return (
                <div key={grup.producte.id} className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => toggleObert(grup.producte.id)}
                    aria-expanded={oberta}
                    className={`${leftBorderClass(grup.liniesFetes === grup.linies)} flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left`}
                  >
                    <ChevronRight
                      aria-hidden
                      className={`mt-1 h-4 w-4 shrink-0 text-gray-500 transition-transform ${oberta ? 'rotate-90' : ''}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium tracking-wide text-gray-500 uppercase">
                        {grup.agrupacioProduccio ?? '—'}
                      </span>
                      <span className="block font-semibold text-gray-900">
                        {grup.producte.descripcio}
                      </span>
                      <span className="block text-xs text-gray-500">{liniesFetesText(grup)}</span>
                    </span>
                    <span className="shrink-0 text-right text-sm text-gray-900">
                      <span className="block">{formatDecimal(grup.unitats, 2)} u.</span>
                      <span className="block">{formatDecimal(grup.kg, 3)} kg</span>
                    </span>
                  </button>
                  {oberta && (
                    <div className="pl-4">
                      <ProducteLinies
                        key={versio}
                        filters={filters}
                        producteId={grup.producte.id}
                        vista="targetes"
                        onChanged={refetch}
                        onRequestUnmark={handleRequestUnmark}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[5%] px-3 py-2">
                    <span className="sr-only">Desplegar</span>
                  </th>
                  <th className="w-[25%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Agrupació producció
                  </th>
                  <th className="w-[40%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Producte
                  </th>
                  <th className="w-[15%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Unitats
                  </th>
                  <th className="w-[15%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Pes (kg)
                  </th>
                </tr>
              </thead>
              <tbody>
                {grups.map((grup) => {
                  const oberta = obertes.has(grup.producte.id);
                  return (
                    <Fragment key={grup.producte.id}>
                      <tr
                        onClick={() => toggleObert(grup.producte.id)}
                        className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
                      >
                        <td
                          className={`${leftBorderClass(grup.liniesFetes === grup.linies)} px-3 py-3 text-center`}
                        >
                          <button
                            type="button"
                            aria-expanded={oberta}
                            aria-label={
                              oberta
                                ? `Plegar les línies de ${grup.producte.descripcio}`
                                : `Desplegar les línies de ${grup.producte.descripcio}`
                            }
                            className="rounded p-1 text-gray-500 hover:bg-gray-100"
                          >
                            <ChevronRight
                              aria-hidden
                              className={`h-4 w-4 transition-transform ${oberta ? 'rotate-90' : ''}`}
                            />
                          </button>
                        </td>
                        <td className="px-3 py-3 break-words text-gray-700">
                          {grup.agrupacioProduccio ?? '—'}
                        </td>
                        <td className="px-3 py-3 break-words">
                          <span className="block font-semibold text-gray-900">
                            {grup.producte.descripcio}
                          </span>
                          <span className="block text-xs text-gray-500">
                            {liniesFetesText(grup)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-gray-900">
                          {formatDecimal(grup.unitats, 2)}
                        </td>
                        <td className="px-3 py-3 text-right font-semibold text-gray-900">
                          {formatDecimal(grup.kg, 3)}
                        </td>
                      </tr>
                      {oberta && (
                        <tr className="border-b border-gray-100">
                          <td colSpan={5} className="bg-gray-50 px-3 py-3">
                            <ProducteLinies
                              key={versio}
                              filters={filters}
                              producteId={grup.producte.id}
                              vista="taula"
                              onChanged={refetch}
                              onRequestUnmark={handleRequestUnmark}
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
        </>
      )}

      <ConfirmDialog
        isOpen={lineToUnmark !== null}
        title="Desmarcar línia"
        message="Vols desmarcar aquesta línia com a treballada? Tornarà a aparèixer com a pendent."
        confirmLabel="Desmarcar"
        confirmingLabel="Desmarcant..."
        onConfirm={handleConfirmUnmark}
        onCancel={handleCancelUnmark}
        errorMessage={unmarkError}
        isConfirming={isUnmarking}
      />
      <ConfirmDialog
        isOpen={isConfirmingMarkAll}
        title="Marcar totes com a fetes"
        message={`Es marcaran com a fetes les ${pendents} línies pendents que compleixen els filtres actuals (no només les de la pàgina visible). Vols continuar?`}
        confirmLabel="Marcar totes"
        confirmingLabel="Marcant..."
        onConfirm={handleConfirmMarkAll}
        onCancel={() => setIsConfirmingMarkAll(false)}
        errorMessage={markAllError}
        isConfirming={isMarkingAll}
      />
    </div>
  );
}
