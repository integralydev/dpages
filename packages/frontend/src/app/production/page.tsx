'use client';

import { Package } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AsyncCombobox } from '@/components/ui/AsyncCombobox';
import { ClearFiltersButton, FilterBar } from '@/components/ui/FilterBar';
import { DataCard, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { DateInput } from '@/components/ui/DateInput';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { StatCard } from '@/components/ui/StatCard';
import { useCatalog } from '@/hooks/useCatalog';
import { useProductionPanell } from '@/hooks/useProductionPanell';
import type { PanellProduccioFilaApi } from '@/lib/api';
import { formatDecimal } from '@/lib/decimals';
import { MAX_LOCAL_COMBOBOX_RESULTS, matchesProductQuery } from '@/lib/productSearch';

const ALL = 'Totes';
const AGRUPACIONS_RENDIMENT = ['KG', 'MAGRE', 'PAQ'];

/**
 * rendiment/diferencia ja arriben com a string amb la precisió que va
 * triar el backend segons el tipus d'agrupació (2 decimals a PAQ, 3 a KG,
 * `panells.ts`) — acá només es converteix el separador, mai es
 * reparseja/redondeja de nou.
 */
function formatBackendDecimal(value: string | null): string {
  return value !== null ? value.replace('.', ',') : '—';
}

function isNegative(value: string | null): boolean {
  return value !== null && Number(value) < 0;
}

// Issue #20 — Rendiment/Diferència per fila NOMÉS tenen sentit de negoci
// per KG/PAQ (l'única branca del backend que els calcula per línia, ver
// panells.ts). La condició depèn del tipus de CADA FILA
// (row.agrupacioRendiment), no del filtre global seleccionat: amb
// "Totes" les files vénen mesclades i cada una s'avalua pel seu propi
// tipus, no totes igual.
function showRowRendiment(agrupacioRendiment: string): boolean {
  return agrupacioRendiment === 'KG' || agrupacioRendiment === 'PAQ';
}

function ProductionRow({
  row,
  showRendiment,
}: {
  row: PanellProduccioFilaApi;
  showRendiment: boolean;
}) {
  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="px-3 py-3 break-words text-gray-900">{row.agrupacioRendiment}</td>
      <td className="px-3 py-3 break-words">
        <span className="font-semibold text-gray-900">{row.agrupacioProduccio}</span>
      </td>
      <td className="px-3 py-3 text-right text-gray-900">{formatBackendDecimal(row.paqPedido)}</td>
      <td className="px-3 py-3 text-right text-gray-900">{formatDecimal(row.kgAElaborar, 3)}</td>
      <td className="px-3 py-3 text-right text-gray-900">
        {showRendiment ? formatBackendDecimal(row.rendiment) : '—'}
      </td>
      <td
        className={`px-3 py-3 text-right ${
          showRendiment && isNegative(row.diferencia)
            ? 'bg-red-600 font-medium text-white'
            : 'text-gray-900'
        }`}
      >
        {showRendiment ? formatBackendDecimal(row.diferencia) : '—'}
      </td>
    </tr>
  );
}

function ProductionCard({
  row,
  showRendiment,
}: {
  row: PanellProduccioFilaApi;
  showRendiment: boolean;
}) {
  return (
    <DataCard>
      <p className="font-semibold text-gray-900">{row.agrupacioProduccio}</p>
      <p className="text-sm text-gray-500">{row.agrupacioRendiment}</p>

      <div className="mt-3">
        <DataCardGrid>
          <DataCardField label="Paq. Comanda">{formatBackendDecimal(row.paqPedido)}</DataCardField>
          <DataCardField label="Kg a Elaborar">{formatDecimal(row.kgAElaborar, 3)}</DataCardField>
          <DataCardField label="Rendiment">
            {showRendiment ? formatBackendDecimal(row.rendiment) : '—'}
          </DataCardField>
          <DataCardField
            label="Diferència"
            tone={showRendiment && isNegative(row.diferencia) ? 'negative' : 'default'}
          >
            {showRendiment ? formatBackendDecimal(row.diferencia) : '—'}
          </DataCardField>
        </DataCardGrid>
      </div>
    </DataCard>
  );
}

// Tasca 34 (01/10/2026): el nombre de porcs es manté fins que el tornin a
// canviar, també després de tancar i obrir sessió — es guarda al navegador
// (preferència de pantalla, no una dada de negoci; és per navegador, no
// per usuari). Sense valor guardat, 1 com sempre.
const CLAU_NOMBRE_PORCS = 'dpages.panellProduccio.nombrePorcs';

function llegirNombrePorcsGuardat(): string {
  if (typeof window === 'undefined') return '1';
  try {
    const valor = window.localStorage.getItem(CLAU_NOMBRE_PORCS);
    return valor && Number(valor) > 0 ? valor : '1';
  } catch {
    return '1';
  }
}

function guardarNombrePorcs(valor: string) {
  if (!(Number(valor) > 0)) return;
  try {
    window.localStorage.setItem(CLAU_NOMBRE_PORCS, valor);
  } catch {
    // Navegador sense localStorage (mode privat estricte): només no es recorda.
  }
}

export default function ProductionPage() {
  const { data: catalog } = useCatalog();

  const [nombrePorcsInput, setNombrePorcsInput] = useState(llegirNombrePorcsGuardat);
  const [agrupacioFilter, setAgrupacioFilter] = useState(ALL);
  const [productFilter, setProductFilter] = useState(ALL);
  // Issue #18 — "sense dades = totes les dades" aplica també acá: ja NO es
  // precarrega cap default visual (abans mirroreava hoy+1..hoy+7, el
  // mateix que aplicava el backend sol quan no rebia dataDes/dataFins).
  // Els camps arrenquen buits de veritat; mentre ho estiguin,
  // `dataDes`/`dataFins` no viatgen al request — el backend interpreta la
  // seva absència com "sense filtre de data", no com "aplica el teu propi
  // default".
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Mode LOCAL (filtrant `catalog` ja carregat), mateix criteri que
  // Producte a OrderForm.tsx — ver lib/productSearch.ts.
  const productId = useMemo(
    () =>
      productFilter !== ALL
        ? (catalog.find((product) => product.descripcio === productFilter)?.id ?? null)
        : null,
    [productFilter, catalog],
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

  // nombrePorcs és obligatori pel backend (400 sense ell) — mai s'envia
  // un default inventat des del frontend (el "12" del mockup no tenia cap
  // suport real). Mentre el camp estigui buit
  // o no sigui > 0, el hook no dispara cap fetch (isReady).
  const nombrePorcs = nombrePorcsInput.trim() === '' ? null : Number(nombrePorcsInput);
  const nombrePorcsValid = nombrePorcs !== null && Number.isFinite(nombrePorcs) && nombrePorcs > 0;
  // El backend ja rebutja ≤0 amb 400 — acá es talla abans de disparar cap
  // fetch i es mostra un missatge concret vora el camp, en comptes de
  // deixar que arribi l'error genèric del backend. El camp buit es tracta
  // exactament igual que 0/negatiu: sense fetch, mateix missatge.
  const nombrePorcsError = !nombrePorcsValid ? 'El mínim és 1.' : null;

  const filters = useMemo(
    () => ({
      nombrePorcs: nombrePorcsValid ? nombrePorcs : null,
      ...(agrupacioFilter !== ALL ? { agrupacioRendiment: agrupacioFilter } : {}),
      ...(productFilter !== ALL ? { producte: productFilter } : {}),
      // Issue #18 — buit = sense filtre de data, es manda tal qual al
      // backend (ver comentari a dateFrom/dateTo més amunt). Ja no fa
      // falta cap flag "touched": el
      // propi valor (buit o no) ja diu tot el que cal.
      ...(dateFrom ? { dataDes: dateFrom } : {}),
      ...(dateTo ? { dataFins: dateTo } : {}),
    }),
    [nombrePorcsValid, nombrePorcs, agrupacioFilter, productFilter, dateFrom, dateTo],
  );

  const { data, totals, paginacio, setPagina, isLoading, error, refetch, isReady } =
    useProductionPanell(filters);

  // Issue #20 — les 3 targetes de capçalera SÍ depenen del filtre ACTIU
  // (sense canvis). Rendiment/Diferència per fila, en canvi, depenen del
  // tipus de cada fila (ver showRowRendiment) — es calcula al moment de
  // pintar cada ProductionRow/ProductionCard, no acá.
  const showTopCards = agrupacioFilter === ALL || agrupacioFilter === 'MAGRE';

  function clearFilters() {
    setAgrupacioFilter(ALL);
    setProductFilter(ALL);
    setDateFrom('');
    setDateTo('');
  }

  return (
    <div>
      <PageHeader
        title="Panell Producció"
        subtitle="Kg a elaborar per producte segons els porcs previstos."
      />

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-gray-900">N° porcs per elaborar</span>
            <input
              type="number"
              min={1}
              value={nombrePorcsInput}
              onChange={(event) => {
                setNombrePorcsInput(event.target.value);
                guardarNombrePorcs(event.target.value);
              }}
              placeholder="Introdueix un valor"
              className="w-full max-w-[160px] rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
            {nombrePorcsError && <span className="text-xs text-red-600">{nombrePorcsError}</span>}
          </label>
          {/* Fix (causa real d'overflow a 1024px, confirmat amb mesura DOM
              real): `sm:grid-cols-3` (minmax(0,1fr) per defecte a Tailwind)
              no té cap límit inferior — a un ample de columna prou estret
              (sidebar + padding de <main> deixaven ~75px reals per targeta
              a 1024px amb la scrollbar vertical present), el text amb
              `whitespace-nowrap` es desbordava de la seva pròpia caixa i
              quedava tallat pel `overflow-hidden` del contenidor pare (mai
              arribava a inflar `document.documentElement.scrollWidth`, per
              això la verificació anterior no ho detectava). Primer intent
              amb `grid-cols-[repeat(auto-fit,minmax(...))]` semblava
              arreglar-ho, però `minmax(Npx, 1fr)` fixa un mínim ARBITRARI,
              no basat en el contingut real — amb valors petits ("0,000")
              trencava a menys columnes sense necessitat (massa
              conservador), i per a un valor prou gran encara podia
              desbordar la seva pròpia columna si "encaixaven" 3 columnes
              pel mínim però no pel contingut real. `flex flex-wrap` sí és
              correcte: cada element ocupa el seu ample de contingut natural
              (mai es comprimeix per sota, com ja demostra aquest mateix
              patró a office/page.tsx i packaging/page.tsx) i BAIXA DE LÍNIA
              sencer quan no hi ha lloc — mai desborda, i en el cas normal
              (valors curts) es manté igual de compacte que abans. */}
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3">
            <div>
              <p className="text-xs font-medium text-gray-500">KG Rendiment Pernil</p>
              <p className="mt-1 text-lg font-bold whitespace-nowrap text-gray-900">
                {formatDecimal(totals?.kgJamon ?? null, 3)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500">KG Retalls</p>
              <p className="mt-1 text-lg font-bold whitespace-nowrap text-gray-900">
                {formatDecimal(totals?.kgRecortes ?? null, 3)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500">KG Espatlles</p>
              <p className="mt-1 text-lg font-bold whitespace-nowrap text-gray-900">
                {formatDecimal(totals?.kgPaletillas ?? null, 3)}
              </p>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          {/* Issue #20 — aquests 3 totals només tenen sentit quan el
              dataset pot incloure files MAGRE (és l'única
              agrupació que alimenta totalKgMagro): filtrant per KG o PAQ es
              queden en 0 sempre, no perquè no hi hagi magre, sinó perquè el
              propi filtre ja les va excloure — mostrar-ho seria enganyós. */}
          {showTopCards && (
            <div className="p-6">
              {/* `flex flex-wrap` — ver comentari extens més amunt (mateix
                  fix, mateixa causa real). Aquests 3 valors vénen
                  d'agregats reals (qualsevol magnitud, no una constant
                  petita) — el motiu original pel qual va aparèixer el bug. */}
              <div className="flex flex-wrap gap-3">
                <StatCard
                  label="TOTAL KG A ELABORAR"
                  value={formatDecimal(totals?.totalKgAElaborar ?? null, 3)}
                />
                <StatCard
                  label="TOTAL KG MAGRE"
                  value={formatDecimal(totals?.totalKgMagro ?? null, 3)}
                />
                <StatCard
                  label="DIFERÈNCIA"
                  value={formatDecimal(totals?.diferencia ?? null, 3)}
                  alert={isNegative(totals?.diferencia ?? null)}
                />
              </div>
            </div>
          )}

          {/* Franja de CANALS — independent de qualsevol filtre d'agrupació
              o producte (elaborat_porc=false a propòsit), només respon al
              filtre de data que ja viatja al fetch. Sempre visible, encara
              que `showTopCards` sigui fals (agrupacioFilter=KG/PAQ oculta
              el bloc de dalt): Canals és el requisit central d'aquest
              disseny, mai pot desaparèixer.
              Color subtil en comptes de l'accent fort — `bg-gray-50`/
              `text-gray-500` són el to secundari ja establert al projecte
              (hover de DataCard, opció seleccionada de
              SimpleDropdown/AsyncCombobox, etc.), no un color nou.
              Alineació: es va abandonar l'alineació EXACTA de columnes amb
              la graella de dalt (`grid-cols-3` calcat) perquè depenia del
              mateix mecanisme de columnes fixes que causava el
              desbordament (ver comentari extens més amunt) — amb `flex
              flex-wrap` cada fila troba el seu propi ample natural, ja no
              hi ha garantia de coincidència píxel a píxel, però mai
              desborda ni es talla, i en el cas normal (valors curts)
              segueix quedant visualment a prop de sota de la graella de
              dalt. */}
          {/* Tasca 35 (01/10/2026): el client no veia gairebé el total de
              canals (franja grisa amb text de 10-14 px). Ara és un bloc
              destacat amb els colors de marca i les xifres grans. */}
          <div
            className={`bg-brand-tint px-6 py-4 ${showTopCards ? 'border-t border-brand-light' : ''}`}
          >
            {/* Tasca 36 (03/10/2026): Canals (categoria CANALS) i, a sota,
                Mitjes Canals (categoria MITJES CANALS), cadascuna amb el
                seu total — ja no se sumen juntes. */}
            <div className="flex flex-col gap-3">
              {[
                { label: 'Canals', valors: totals?.canals },
                { label: 'Mitjes Canals', valors: totals?.mitgesCanals },
              ].map(({ label, valors }) => (
                <div key={label} className="flex flex-wrap items-center gap-x-10 gap-y-3">
                  <div className="flex w-44 items-center gap-2">
                    <Package className="h-5 w-5 shrink-0 text-ink" aria-hidden="true" />
                    <span className="text-base font-bold tracking-wide text-ink uppercase">
                      {label}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">
                      Unitats
                    </p>
                    <p className="w-24 text-2xl font-bold whitespace-nowrap text-gray-900">
                      {formatDecimal(valors?.unitats ?? null, 2)}
                    </p>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">
                      Kg
                    </p>
                    <p className="text-2xl font-bold whitespace-nowrap text-gray-900">
                      {formatDecimal(valors?.kg ?? null, 3)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <FilterBar>
        <SimpleDropdown
          label="Agrupació Rendiment"
          options={AGRUPACIONS_RENDIMENT}
          value={agrupacioFilter}
          onChange={setAgrupacioFilter}
          allLabel={ALL}
        />
        <AsyncCombobox
          label="Producte"
          value={productId}
          displayValue={productFilter !== ALL ? productFilter : ''}
          placeholder="Cercar producte..."
          debounceMs={0}
          loadOptions={loadProductOptions}
          onChange={(option) => setProductFilter(option?.label ?? ALL)}
        />
        <DateInput label="Data producció des de" value={dateFrom} onChange={setDateFrom} />
        <DateInput label="Data producció fins a" value={dateTo} onChange={setDateTo} />
        <ClearFiltersButton onClick={clearFilters} />
      </FilterBar>

      {!isReady && (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
          Introdueix el nombre de porcs per elaborar per veure els càlculs.
        </p>
      )}
      {isReady && isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {isReady && error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;han pogut carregar les dades: {error.message}
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

      {isReady && !isLoading && !error && (
        <>
          <div className="flex flex-col gap-3 md:hidden">
            {data.map((row) => (
              <ProductionCard
                key={`${row.agrupacioProduccio}-${row.agrupacioRendiment}`}
                row={row}
                showRendiment={showRowRendiment(row.agrupacioRendiment)}
              />
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[13%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Agrupació Rendiment
                  </th>
                  <th className="w-[22%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Agrupació Producció
                  </th>
                  <th className="w-[16%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Paq. Comanda
                  </th>
                  <th className="w-[16%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Kg a Elaborar
                  </th>
                  <th className="w-[16%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Rendiment
                  </th>
                  <th className="w-[17%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Diferència
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <ProductionRow
                    key={`${row.agrupacioProduccio}-${row.agrupacioRendiment}`}
                    row={row}
                    showRendiment={showRowRendiment(row.agrupacioRendiment)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Probablement sempre totalPagines=1 en la pràctica (les files
              venen d'un GROUP BY agrupacioProduccio×agrupacioRendiment,
              acotat pel catàleg real) — es mostra igual per consistència
              amb la resta de pantalles. */}
          {paginacio && <Pagination paginacio={paginacio} onPageChange={setPagina} />}
        </>
      )}
    </div>
  );
}
