'use client';

import { useMemo, useState } from 'react';
import { AsyncCombobox, type ComboboxOption } from '@/components/ui/AsyncCombobox';
import { DateInput } from '@/components/ui/DateInput';
import { DateRangeInput } from '@/components/ui/DateRangeInput';
import { ClearFiltersButton, FilterBar } from '@/components/ui/FilterBar';
import { MultiCombobox } from '@/components/ui/MultiCombobox';
import { SearchInput } from '@/components/ui/SearchInput';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { useCarriers } from '@/hooks/useCarriers';
import { useCatalog } from '@/hooks/useCatalog';
import { useCategories } from '@/hooks/useCategories';
import { useOrigensComanda } from '@/hooks/useOrigensComanda';
import type { PackagingPanelFilters } from '@/hooks/usePanellEmpaquetat';
import { api, type ClientApi, type RespostaPaginada } from '@/lib/api';
import { MAX_LOCAL_COMBOBOX_RESULTS, matchesProductQuery } from '@/lib/productSearch';

// Filtres del Panell Empaquetat. Vivien a packaging/page.tsx; es comparteixen
// des de la tasca 41 perquè el Panell de Compres és la mateixa informació
// acumulada per client i ha de filtrar exactament igual (el backend també
// comparteix els filtres: construirFiltresEmpaquetat a panells.ts).

const ALL = 'Tots';
const ALL_FEM = 'Totes';

// Petició d'Ari (29/09/2026): una línia és "enviada" quan s'hi han desat
// unitats i quilos enviats (confirmatA no null). Etiqueta → valor de
// `?confirmacio=` al backend; "Totes" = sense filtre.
const CONFIRMACIO_OPTIONS = {
  Pendents: 'pendents',
  Enviades: 'confirmades',
} as const satisfies Record<string, 'pendents' | 'confirmades'>;

// Tasca 23 (01/10/2026): amb / sense observacions de la línia.
const OBSERVACIONS_OPTIONS = { 'Amb observacions': 'si', 'Sense observacions': 'no' } as const;

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

/**
 * Estat dels filtres + l'objecte `filters` llest per al backend. La barra
 * es pinta amb `<PackagingFilterBar state={...} />`.
 */
export function usePackagingFilters() {
  const { data: carriers } = useCarriers();
  const { data: catalog } = useCatalog();
  const { data: categories } = useCategories();

  // Tasca 52 (Ari, 20/10/2026): data d'expedició com a rang des de / fins a.
  const [shippingDateFrom, setShippingDateFrom] = useState('');
  const [shippingDateTo, setShippingDateTo] = useState('');
  // Un o més transportistes (tasca 22, 01/10/2026), mateix patró que Productes.
  const [selectedCarriers, setSelectedCarriers] = useState<ComboboxOption[]>([]);
  // Client ja no ve d'un <select> amb els clients de useClientTariffs()
  // precarregats (per defecte només 200, i n'hi ha 1291 reals — el filtre
  // ja quedava incomplet abans d'aquest canvi) — AsyncCombobox el resol via
  // GET /clients?cerca=, mateix patró que office/page.tsx i OrderForm.tsx.
  // Es guarda l'opció sencera (id+label): no hi ha cap array complet
  // d'on resoldre l'etiqueta a mostrar després.
  const [selectedClient, setSelectedClient] = useState<ComboboxOption | null>(null);
  // dataLliuramentDes/Fins (rang) i producte (exacte, case-insensitive; un
  // o més, mateix patró que Obrador) ja tenen suport real al backend. Mateix patró que
  // l'antic camp únic de "Data d'expedició" (enviat com Des=Fins=mateix valor).
  // Producte segueix en mode LOCAL (filtrant `catalog` ja carregat, mateix
  // criteri que Producte a OrderForm.tsx) — veure lib/productSearch.ts.
  const [deliveryDateFilter, setDeliveryDateFilter] = useState('');
  const [selectedProducts, setSelectedProducts] = useState<ComboboxOption[]>([]);
  // Tasca 45 (Ari, 20/10/2026): cerca per codi o descripció mentre
  // s'escriu, com al Catàleg ("botifarra" les troba totes).
  const [productSearch, setProductSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState(ALL_FEM);
  // Tasca 48 (Ari, 20/10/2026): origen de la comanda (tots els orígens,
  // també WooCommerce), mateix filtre que a Comandes.
  const { data: origins } = useOrigensComanda();
  const [originFilter, setOriginFilter] = useState(ALL);
  const originCode = useMemo(
    () =>
      originFilter !== ALL
        ? origins.find((origin) => origin.nom === originFilter)?.codi
        : undefined,
    [originFilter, origins],
  );
  const [confirmacioFilter, setConfirmacioFilter] = useState(ALL_FEM);
  const [observacionsFilter, setObservacionsFilter] = useState(ALL_FEM);
  const observacions =
    OBSERVACIONS_OPTIONS[observacionsFilter as keyof typeof OBSERVACIONS_OPTIONS] ?? undefined;

  const categoriaId = useMemo(
    () =>
      categoryFilter !== ALL_FEM
        ? categories.find((item) => item.nom === categoryFilter)?.id
        : undefined,
    [categoryFilter, categories],
  );
  const confirmacio =
    CONFIRMACIO_OPTIONS[confirmacioFilter as keyof typeof CONFIRMACIO_OPTIONS] ?? undefined;

  const loadCarrierOptions = useMemo(
    () => (query: string) =>
      Promise.resolve(
        carriers
          .filter((item) => item.nom.toLowerCase().includes(query.toLowerCase()))
          .map((item) => ({ id: item.id, label: item.nom }))
          .sort((a, b) => a.label.localeCompare(b.label, 'ca')),
      ),
    [carriers],
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

  const filters: PackagingPanelFilters = useMemo(
    () => ({
      ...(shippingDateFrom ? { dataExpedicioDes: shippingDateFrom } : {}),
      ...(shippingDateTo ? { dataExpedicioFins: shippingDateTo } : {}),
      ...(selectedCarriers.length > 0
        ? { transportistaId: selectedCarriers.map((item) => item.id) }
        : {}),
      ...(selectedClient !== null ? { clientId: selectedClient.id } : {}),
      ...(deliveryDateFilter
        ? { dataLliuramentDes: deliveryDateFilter, dataLliuramentFins: deliveryDateFilter }
        : {}),
      ...(selectedProducts.length > 0
        ? { producte: selectedProducts.map((product) => product.label) }
        : {}),
      ...(productSearch.trim() ? { cercaProducte: productSearch.trim() } : {}),
      ...(categoriaId !== undefined ? { categoriaId } : {}),
      ...(originCode ? { origen: originCode } : {}),
      ...(confirmacio !== undefined ? { confirmacio } : {}),
      ...(observacions !== undefined ? { observacions } : {}),
    }),
    [
      shippingDateFrom,
      shippingDateTo,
      selectedCarriers,
      selectedClient,
      deliveryDateFilter,
      selectedProducts,
      productSearch,
      categoriaId,
      originCode,
      confirmacio,
      observacions,
    ],
  );

  function clearFilters() {
    setShippingDateFrom('');
    setShippingDateTo('');
    setSelectedCarriers([]);
    setSelectedClient(null);
    setDeliveryDateFilter('');
    setSelectedProducts([]);
    setProductSearch('');
    setCategoryFilter(ALL_FEM);
    setOriginFilter(ALL);
    setConfirmacioFilter(ALL_FEM);
    setObservacionsFilter(ALL_FEM);
  }

  return {
    filters,
    state: {
      categories,
      origins,
      shippingDateFrom,
      setShippingDateFrom,
      shippingDateTo,
      setShippingDateTo,
      selectedCarriers,
      setSelectedCarriers,
      selectedClient,
      setSelectedClient,
      deliveryDateFilter,
      setDeliveryDateFilter,
      selectedProducts,
      setSelectedProducts,
      productSearch,
      setProductSearch,
      categoryFilter,
      setCategoryFilter,
      originFilter,
      setOriginFilter,
      confirmacioFilter,
      setConfirmacioFilter,
      observacionsFilter,
      setObservacionsFilter,
      loadCarrierOptions,
      loadProductOptions,
      clearFilters,
    },
  };
}

type PackagingFiltersState = ReturnType<typeof usePackagingFilters>['state'];

/**
 * Dues files, com al Panell Obrador: a dalt els filtres curts, a baix els
 * cercadors (Client ja no queda sol en una fila).
 */
export function PackagingFilterBar({ state }: { state: PackagingFiltersState }) {
  return (
    <FilterBar>
      <div className="flex w-full flex-wrap gap-4">
        <SimpleDropdown
          label="Enviament"
          options={Object.keys(CONFIRMACIO_OPTIONS)}
          value={state.confirmacioFilter}
          onChange={state.setConfirmacioFilter}
          allLabel={ALL_FEM}
        />
        <SimpleDropdown
          label="Observacions"
          options={Object.keys(OBSERVACIONS_OPTIONS)}
          value={state.observacionsFilter}
          onChange={state.setObservacionsFilter}
          allLabel={ALL_FEM}
        />
        <SimpleDropdown
          label="Categoria"
          options={state.categories.map((item) => item.nom)}
          value={state.categoryFilter}
          onChange={state.setCategoryFilter}
          allLabel={ALL_FEM}
        />
        <SimpleDropdown
          label="Origen"
          options={state.origins.map((origin) => origin.nom)}
          value={state.originFilter}
          onChange={state.setOriginFilter}
          allLabel={ALL}
        />
        <DateRangeInput
          label="Data d'expedició"
          from={state.shippingDateFrom}
          to={state.shippingDateTo}
          onFromChange={state.setShippingDateFrom}
          onToChange={state.setShippingDateTo}
        />
        <DateInput
          label="Data de lliurament"
          value={state.deliveryDateFilter}
          onChange={state.setDeliveryDateFilter}
        />
      </div>
      <div className="flex w-full flex-wrap gap-4">
        <MultiCombobox
          label="Transportistes"
          selected={state.selectedCarriers}
          onChange={state.setSelectedCarriers}
          placeholder="Cercar transportista..."
          addMorePlaceholder="Afegir un altre transportista..."
          debounceMs={0}
          loadOptions={state.loadCarrierOptions}
        />
        <SearchInput
          label="Cerca producte"
          placeholder="Codi o descripció..."
          value={state.productSearch}
          onChange={state.setProductSearch}
        />
        <MultiCombobox
          label="Productes"
          selected={state.selectedProducts}
          onChange={state.setSelectedProducts}
          placeholder="Cercar producte..."
          addMorePlaceholder="Afegir un altre producte..."
          debounceMs={0}
          loadOptions={state.loadProductOptions}
        />
        <AsyncCombobox
          label="Client"
          value={state.selectedClient?.id ?? null}
          displayValue={state.selectedClient?.label ?? ''}
          placeholder="Cercar client..."
          onChange={state.setSelectedClient}
          loadOptions={loadClientOptions}
        />
        <ClearFiltersButton onClick={state.clearFilters} />
      </div>
    </FilterBar>
  );
}
