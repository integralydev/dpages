'use client';

import { useMemo, useState } from 'react';
import { AsyncCombobox, type ComboboxOption } from '@/components/ui/AsyncCombobox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ClearFiltersButton, FilterBar } from '@/components/ui/FilterBar';
import { MultiCombobox } from '@/components/ui/MultiCombobox';
import { DataCard, DataCardActions, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { DateInput } from '@/components/ui/DateInput';
import { DecimalInput } from '@/components/ui/DecimalInput';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { StatCard } from '@/components/ui/StatCard';
import { useCarriers } from '@/hooks/useCarriers';
import { useCatalog } from '@/hooks/useCatalog';
import { useCategories } from '@/hooks/useCategories';
import { useEditableRow } from '@/hooks/useEditableRow';
import { type LliuramentSaveResult, usePanellEmpaquetat } from '@/hooks/usePanellEmpaquetat';
import {
  api,
  type ClientApi,
  type FilaPanellEmpaquetatApi,
  type RespostaPaginada,
} from '@/lib/api';
import { formatData } from '@/lib/dates';
import { formatDecimal, parseDecimalInput } from '@/lib/decimals';
import { MAX_LOCAL_COMBOBOX_RESULTS, matchesProductQuery } from '@/lib/productSearch';

const ALL = 'Tots';
const ALL_FEM = 'Totes';

// Petició d'Ari (29/09/2026): una línia és "enviada" quan s'hi han desat
// unitats i quilos enviats (confirmatA no null). Etiqueta → valor de
// `?confirmacio=` al backend; "Totes" = sense filtre.
const CONFIRMACIO_OPTIONS = {
  Pendents: 'pendents',
  Enviades: 'confirmades',
} as const satisfies Record<string, 'pendents' | 'confirmades'>;

function clientLabel(client: ClientApi) {
  return `${client.codi ?? client.id} · ${client.nom ?? ''}`;
}

// Mateix patró que office/page.tsx i OrderForm.tsx: GET /clients?cerca= és
// substring case-insensitive real, per això Client fa servir mode servidor
// (abans carregava els 200 clients per defecte de useClientTariffs() només
// per a aquest filtre — amb 1291 clients reals, ja quedava incomplet).
async function loadClientOptions(query: string): Promise<ComboboxOption[]> {
  const resposta = await api.get<RespostaPaginada<ClientApi>>('/clients', {
    cerca: query,
    mida: 8,
  });
  return resposta.dades.map((client) => ({ id: client.id, label: clientLabel(client) }));
}

// "0" pla en comptes de "0.000"/"0.00" — mateix criteri que kgDemanats a
// Comandes, evita que el cursor caigui enmig dels decimals en fer clic.
// NOMÉS per a una línia encara NO confirmada (confirmatA === null): si ja
// es va confirmar una entrega abans (encara que casualment fos zero per
// una merma total), és un valor real ja resolt i es mostra tal qual, mai
// simplificat.
function initialDeliveredValue(value: string, confirmatA: string | null): string {
  return confirmatA === null && Number(value) === 0 ? '0' : value;
}

// Issue #19 — abans era sempre disabled (l'única forma de marcar-la era
// carregar unitats/kg i Guardar). Ara, si la línia ja està confirmada,
// aquest mateix checkbox és l'acció per desfer-la (onRequestUndo obre el
// ConfirmDialog, mai muta l'estat directament des d'acá). Sobre una línia
// encara pendent (confirmatA === null) segueix sent purament informatiu i
// disabled — no té sentit "desfer" una confirmació que mai va existir.
function WorkedCheckbox({
  confirmatA,
  onRequestUndo,
}: {
  confirmatA: string | null;
  onRequestUndo?: () => void;
}) {
  const isConfirmed = confirmatA !== null;
  return (
    <input
      type="checkbox"
      checked={isConfirmed}
      disabled={!isConfirmed}
      onChange={onRequestUndo}
      aria-label={isConfirmed ? 'Desfer confirmació de la línia' : 'Línia pendent'}
      className="h-4 w-4 rounded border-gray-300 text-ink disabled:cursor-not-allowed"
    />
  );
}

function leftBorderClass(confirmatA: string | null) {
  return confirmatA !== null ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-gray-200';
}

type Draft = { unitatsLliurades: string; kgLliurats: string };

function PackagingRow({
  line,
  onSave,
  onRequestUndo,
}: {
  line: FilaPanellEmpaquetatApi;
  onSave: (
    comandaId: number,
    liniaId: number,
    unitatsLliurades: number,
    kgLliurats: string,
  ) => Promise<LliuramentSaveResult>;
  onRequestUndo: (line: FilaPanellEmpaquetatApi) => void;
}) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const initialValues: Draft = {
    unitatsLliurades: initialDeliveredValue(line.unitatsLliurades, line.confirmatA),
    kgLliurats: initialDeliveredValue(line.kgLliurats, line.confirmatA),
  };

  const { draft, setField, save, isDirty } = useEditableRow(initialValues, async (values) => {
    // El PATCH exigeix els dos camps sempre junts (contrato §5) — encara
    // que la fila només hagi tocat un dels dos, es manda el valor actual
    // del que no es va tocar més el nou de l'altre.
    const unitatsLliurades = Number(values.unitatsLliurades);
    const kgLliurats = parseDecimalInput(values.kgLliurats, 3);

    setIsSaving(true);
    setFieldErrors({});
    setGeneralError(null);
    const result = await onSave(line.comandaId, line.liniaId, unitatsLliurades, kgLliurats);
    setIsSaving(false);

    if (!result.success) {
      setFieldErrors(result.fieldErrors);
      setGeneralError(result.generalError);
    }
  });

  return (
    <tr className="border-b border-gray-100 last:border-0">
      {/* Primera columna (petició d'Ari) i sempre visible: porta la franja
          de color pendent/enviada en tots els tamanys de pantalla. */}
      <td className={`${leftBorderClass(line.confirmatA)} px-3 py-3 break-words text-gray-700`}>
        {line.categoria ?? '—'}
      </td>
      <td className="hidden px-3 py-3 text-center xl:table-cell">
        <WorkedCheckbox
          confirmatA={line.confirmatA}
          onRequestUndo={line.confirmatA !== null ? () => onRequestUndo(line) : undefined}
        />
      </td>
      <td className="hidden px-3 py-3 break-words text-gray-900 xl:table-cell">
        {line.dataExpedicio ? formatData(line.dataExpedicio, false) : '—'}
      </td>
      <td className="hidden px-3 py-3 break-words text-gray-900 xl:table-cell">
        {line.dataLliurament ? formatData(line.dataLliurament, false) : '—'}
      </td>
      <td className="hidden px-3 py-3 break-words text-gray-900 xl:table-cell">
        {line.transportista ?? '—'}
      </td>
      <td className="px-3 py-3 break-words">
        <span className="font-semibold text-gray-900">{line.producte}</span>
      </td>
      <td className="hidden px-3 py-3 break-words text-gray-900 xl:table-cell">
        {line.client ?? '—'}
      </td>
      <td className="px-3 py-3 text-right text-gray-900">
        {formatDecimal(line.unitatsDemanades, 2)}
      </td>
      <td className="px-3 py-3">
        <DecimalInput
          value={draft.unitatsLliurades}
          onChange={(value) => setField('unitatsLliurades', value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-right text-sm text-gray-900 focus:border-brand focus:outline-none"
        />
        {fieldErrors.unitatsLliurades && (
          <p className="mt-1 text-xs text-red-600">{fieldErrors.unitatsLliurades}</p>
        )}
      </td>
      <td className="px-3 py-3 text-right text-gray-900">{formatDecimal(line.kgDemanats, 3)}</td>
      <td className="px-3 py-3">
        <DecimalInput
          value={draft.kgLliurats}
          onChange={(value) => setField('kgLliurats', value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-right text-sm text-gray-900 focus:border-brand focus:outline-none"
        />
        {fieldErrors.kgLliurats && (
          <p className="mt-1 text-xs text-red-600">{fieldErrors.kgLliurats}</p>
        )}
      </td>
      <td className="px-3 py-3 text-center align-top">
        <button
          type="button"
          onClick={save}
          disabled={!isDirty || isSaving}
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
            isDirty && !isSaving
              ? 'bg-ink text-white hover:opacity-90'
              : 'cursor-not-allowed bg-gray-200 text-gray-400'
          }`}
        >
          {isSaving ? 'Desant...' : 'Desar'}
        </button>
        {generalError && <p className="mt-1 max-w-[140px] text-xs text-red-600">{generalError}</p>}
      </td>
    </tr>
  );
}

function PackagingCard({
  line,
  onSave,
  onRequestUndo,
}: {
  line: FilaPanellEmpaquetatApi;
  onSave: (
    comandaId: number,
    liniaId: number,
    unitatsLliurades: number,
    kgLliurats: string,
  ) => Promise<LliuramentSaveResult>;
  onRequestUndo: (line: FilaPanellEmpaquetatApi) => void;
}) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const initialValues: Draft = {
    unitatsLliurades: initialDeliveredValue(line.unitatsLliurades, line.confirmatA),
    kgLliurats: initialDeliveredValue(line.kgLliurats, line.confirmatA),
  };

  const { draft, setField, save, isDirty } = useEditableRow(initialValues, async (values) => {
    const unitatsLliurades = Number(values.unitatsLliurades);
    const kgLliurats = parseDecimalInput(values.kgLliurats, 3);

    setIsSaving(true);
    setFieldErrors({});
    setGeneralError(null);
    const result = await onSave(line.comandaId, line.liniaId, unitatsLliurades, kgLliurats);
    setIsSaving(false);

    if (!result.success) {
      setFieldErrors(result.fieldErrors);
      setGeneralError(result.generalError);
    }
  });

  return (
    <div className="relative overflow-hidden rounded-xl">
      <div
        className={`absolute inset-y-0 left-0 w-1 ${line.confirmatA !== null ? 'bg-green-500' : 'bg-gray-200'}`}
      />
      <DataCard>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
              {line.categoria ?? '—'}
            </p>
            <p className="font-semibold text-gray-900">{line.producte}</p>
            <p className="text-sm text-gray-500">{line.client ?? '—'}</p>
          </div>
          <WorkedCheckbox
            confirmatA={line.confirmatA}
            onRequestUndo={line.confirmatA !== null ? () => onRequestUndo(line) : undefined}
          />
        </div>

        <div className="mt-3">
          <DataCardGrid>
            <DataCardField label="Data d'expedició">
              {line.dataExpedicio ? formatData(line.dataExpedicio, false) : '—'}
            </DataCardField>
            <DataCardField label="Data de lliurament">
              {line.dataLliurament ? formatData(line.dataLliurament, false) : '—'}
            </DataCardField>
            <DataCardField label="Transportista">{line.transportista ?? '—'}</DataCardField>
            <DataCardField label="Unitats demanades">
              {formatDecimal(line.unitatsDemanades, 2)}
            </DataCardField>
            <DataCardField label="Kilos demanats">
              {formatDecimal(line.kgDemanats, 3)}
            </DataCardField>
          </DataCardGrid>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-gray-500">Unitats lliurades</span>
            <DecimalInput
              value={draft.unitatsLliurades}
              onChange={(value) => setField('unitatsLliurades', value)}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
            {fieldErrors.unitatsLliurades && (
              <p className="text-xs text-red-600">{fieldErrors.unitatsLliurades}</p>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-gray-500">Kilos lliurats</span>
            <DecimalInput
              value={draft.kgLliurats}
              onChange={(value) => setField('kgLliurats', value)}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
            {fieldErrors.kgLliurats && (
              <p className="text-xs text-red-600">{fieldErrors.kgLliurats}</p>
            )}
          </label>
        </div>

        <DataCardActions>
          <button
            type="button"
            onClick={save}
            disabled={!isDirty || isSaving}
            className={`w-full rounded-full px-3 py-2 text-sm font-semibold ${
              isDirty && !isSaving
                ? 'bg-ink text-white hover:opacity-90'
                : 'cursor-not-allowed bg-gray-200 text-gray-400'
            }`}
          >
            {isSaving ? 'Desant...' : 'Desar'}
          </button>
        </DataCardActions>
        {generalError && <p className="mt-2 text-xs text-red-600">{generalError}</p>}
      </DataCard>
    </div>
  );
}

export default function PackagingPage() {
  const { data: carriers } = useCarriers();
  const { data: catalog } = useCatalog();
  const { data: categories } = useCategories();

  const [shippingDateFilter, setShippingDateFilter] = useState('');
  const [carrierFilter, setCarrierFilter] = useState(ALL);
  // Client ja no ve d'un <select> amb els clients de useClientTariffs()
  // precarregats (per defecte només 200, i n'hi ha 1291 reals — el filtre
  // ja quedava incomplet abans d'aquest canvi) — AsyncCombobox el resol via
  // GET /clients?cerca=, mateix patró que office/page.tsx i OrderForm.tsx.
  // Es guarda l'opció sencera (id+label): no hi ha cap array complet
  // d'on resoldre l'etiqueta a mostrar després.
  const [selectedClient, setSelectedClient] = useState<ComboboxOption | null>(null);
  // dataLliuramentDes/Fins (rang) i producte (exacte, case-insensitive; un
  // o més, mateix patró que Obrador) ja tenen suport real al backend. Mateix patró que
  // "Data d'expedició" (un sol camp, enviat com Des=Fins=mateix valor).
  // Producte segueix en mode LOCAL (filtrant `catalog` ja carregat, mateix
  // criteri que Producte a OrderForm.tsx): GET /productes?cerca= fa
  // coincidència EXACTA a propòsit (regla 3.1), no serveix per a cerca
  // incremental — veure lib/productSearch.ts.
  const [deliveryDateFilter, setDeliveryDateFilter] = useState('');
  const [selectedProducts, setSelectedProducts] = useState<ComboboxOption[]>([]);
  const [categoryFilter, setCategoryFilter] = useState(ALL_FEM);
  const [confirmacioFilter, setConfirmacioFilter] = useState(ALL_FEM);

  const categoriaId = useMemo(
    () =>
      categoryFilter !== ALL_FEM
        ? categories.find((item) => item.nom === categoryFilter)?.id
        : undefined,
    [categoryFilter, categories],
  );
  const confirmacio =
    CONFIRMACIO_OPTIONS[confirmacioFilter as keyof typeof CONFIRMACIO_OPTIONS] ?? undefined;

  const carrierId = useMemo(
    () =>
      carrierFilter !== ALL ? carriers.find((item) => item.nom === carrierFilter)?.id : undefined,
    [carrierFilter, carriers],
  );
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
      ...(shippingDateFilter
        ? { dataExpedicioDes: shippingDateFilter, dataExpedicioFins: shippingDateFilter }
        : {}),
      ...(carrierId !== undefined ? { transportistaId: carrierId } : {}),
      ...(selectedClient !== null ? { clientId: selectedClient.id } : {}),
      ...(deliveryDateFilter
        ? { dataLliuramentDes: deliveryDateFilter, dataLliuramentFins: deliveryDateFilter }
        : {}),
      ...(selectedProducts.length > 0
        ? { producte: selectedProducts.map((product) => product.label) }
        : {}),
      ...(categoriaId !== undefined ? { categoriaId } : {}),
      ...(confirmacio !== undefined ? { confirmacio } : {}),
    }),
    [
      shippingDateFilter,
      carrierId,
      selectedClient,
      deliveryDateFilter,
      selectedProducts,
      categoriaId,
      confirmacio,
    ],
  );

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

  function clearFilters() {
    setShippingDateFilter('');
    setCarrierFilter(ALL);
    setSelectedClient(null);
    setDeliveryDateFilter('');
    setSelectedProducts([]);
    setCategoryFilter(ALL_FEM);
    setConfirmacioFilter(ALL_FEM);
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

      <FilterBar>
        <SimpleDropdown
          label="Enviament"
          options={Object.keys(CONFIRMACIO_OPTIONS)}
          value={confirmacioFilter}
          onChange={setConfirmacioFilter}
          allLabel={ALL_FEM}
        />
        <SimpleDropdown
          label="Categoria"
          options={categories.map((item) => item.nom)}
          value={categoryFilter}
          onChange={setCategoryFilter}
          allLabel={ALL_FEM}
        />
        <DateInput
          label="Data d'expedició"
          value={shippingDateFilter}
          onChange={setShippingDateFilter}
        />
        <DateInput
          label="Data de lliurament"
          value={deliveryDateFilter}
          onChange={setDeliveryDateFilter}
        />
        <SimpleDropdown
          label="Transportista"
          options={carriers.map((item) => item.nom)}
          value={carrierFilter}
          onChange={setCarrierFilter}
          allLabel={ALL}
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
                  <th className="w-[8%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Categoria
                  </th>
                  <th className="hidden w-[4%] px-3 py-2 text-center font-medium text-gray-500 break-words xl:table-cell">
                    <span className="sr-only">Treballada</span>
                  </th>
                  <th className="hidden w-[9%] px-3 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Data d&apos;expedició
                  </th>
                  <th className="hidden w-[8%] px-3 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Data de lliurament
                  </th>
                  <th className="hidden w-[9%] px-3 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Transportista
                  </th>
                  <th className="w-[12%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Producte
                  </th>
                  <th className="hidden w-[8%] px-3 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Client
                  </th>
                  <th className="w-[9%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Unitats demanades
                  </th>
                  <th className="w-[8%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Unitats lliurades
                  </th>
                  <th className="w-[8%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Kilos demanats
                  </th>
                  <th className="w-[8%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Kilos lliurats
                  </th>
                  <th className="w-[9%] px-3 py-2 text-center font-medium text-gray-500 break-words">
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
