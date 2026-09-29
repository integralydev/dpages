'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Printer } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataCard, DataCardActions, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { DateInput } from '@/components/ui/DateInput';
import { FilterBar } from '@/components/ui/FilterBar';
import { IconButton } from '@/components/ui/IconButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SearchInput } from '@/components/ui/SearchInput';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { useOrders } from '@/hooks/useOrders';
import { useOrigensComanda } from '@/hooks/useOrigensComanda';
import { ESTAT_LABELS, estatBadgeVariant } from '@/lib/comandaEstat';
import {
  api,
  ApiError,
  obtenirTotesLesPagines,
  type ComandaResumApi,
  type RespostaPaginada,
} from '@/lib/api';
import { origenBadgeVariant } from '@/lib/comandaOrigen';
import { formatData } from '@/lib/dates';
import { descarregarPdfLlistatComandes } from '@/lib/ordersPdf';

const ALL = 'Tots';

function productionDates(order: ComandaResumApi): string {
  return order.datesProduccioLinies.map((data) => formatData(data, false)).join(', ');
}

function OrderCard({
  order,
  originLabel,
  onOpen,
  onMarkIncidence,
}: {
  order: ComandaResumApi;
  originLabel: (codi: string) => string;
  onOpen: () => void;
  onMarkIncidence: () => void;
}) {
  return (
    <DataCard>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-900">{order.num}</p>
          <p className="text-sm text-gray-500">{order.client?.nom ?? '—'}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={estatBadgeVariant(order.estat)}>
            {ESTAT_LABELS[order.estat] ?? order.estat}
          </Badge>
          {order.congelada && <Badge variant="neutral">Congelada</Badge>}
        </div>
      </div>

      <div className="mt-3">
        <DataCardGrid>
          <DataCardField label="Origen">
            <Badge variant={origenBadgeVariant(order.origen)}>{originLabel(order.origen)}</Badge>
          </DataCardField>
          <DataCardField label="Tarifa">{order.tarifa?.nom ?? '—'}</DataCardField>
          <DataCardField label="Transportista">{order.transportista?.nom ?? '—'}</DataCardField>
          <DataCardField label="Data comanda">{formatData(order.dataComanda, false)}</DataCardField>
          <DataCardField label="Data producció">{productionDates(order) || '—'}</DataCardField>
          <DataCardField label="Data lliurament">
            {order.dataLliurament ? formatData(order.dataLliurament, false) : '—'}
          </DataCardField>
          <DataCardField label="Bultos">{order.bultos ?? '—'}</DataCardField>
        </DataCardGrid>
      </div>

      <DataCardActions>
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Editar
        </button>
        {order.estat !== 'amb_incidencia' && order.estat !== 'cancellada' && (
          <button
            type="button"
            onClick={onMarkIncidence}
            className="flex-1 rounded-full border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            Marcar incidència
          </button>
        )}
      </DataCardActions>
    </DataCard>
  );
}

export default function OrdersPage() {
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [productionDateFilter, setProductionDateFilter] = useState('');
  const [orderDateFilter, setOrderDateFilter] = useState('');
  const [deliveryDateFilter, setDeliveryDateFilter] = useState('');
  const [incidenceTarget, setIncidenceTarget] = useState<ComandaResumApi | null>(null);
  const [incidenceDetall, setIncidenceDetall] = useState('');
  const [incidenceError, setIncidenceError] = useState<string | null>(null);
  const [isMarkingIncidence, setIsMarkingIncidence] = useState(false);

  const statusCode = useMemo(
    () => Object.entries(ESTAT_LABELS).find(([, label]) => label === statusFilter)?.[0],
    [statusFilter],
  );

  // Issue #17 — `cerca` ja és real a GET /comandes
  // (ILIKE sobre `c.num` O `cl.nom`, confirmat contra comandes.ts):
  // reemplaça els dos buscadors separats ("Núm. comanda" i "Client") que
  // hi havia abans, un d'ells (Client) filtrant client-side amb
  // totals/resultats inconsistents (mateix bug que Catàleg). Es fusionen
  // en un sol input perquè el backend ja els tracta com un sol OR, no com
  // dos filtres independents — mai té sentit mandar dos substrings
  // diferents en un mateix `cerca`.
  //
  // LIMITACIÓ NOVA (no hi era abans): el buscador vell també matchejava
  // pel CODI del client (`client.codi`, ex. "CLI213"), creuant contra
  // useClientTariffs(). El `cerca` real del backend NOMÉS cobreix
  // `cl.nom` — no `cl.codi` (confirmat llegint comandes.ts sencer). Buscar
  // un pedido pel codi del seu client ja no funciona; caldria ampliar el
  // OR del backend per recuperar-ho.
  const filters = useMemo(
    () => ({
      ...(statusCode ? { estat: statusCode } : {}),
      ...(orderDateFilter ? { dataDes: orderDateFilter, dataFins: orderDateFilter } : {}),
      ...(productionDateFilter
        ? { dataProduccioDes: productionDateFilter, dataProduccioFins: productionDateFilter }
        : {}),
      ...(deliveryDateFilter
        ? { dataLliuramentDes: deliveryDateFilter, dataLliuramentFins: deliveryDateFilter }
        : {}),
      ...(search.trim() ? { cerca: search.trim() } : {}),
    }),
    [statusCode, orderDateFilter, productionDateFilter, deliveryDateFilter, search],
  );

  const { data, paginacio, setPagina, isLoading, error, refetch, markIncidence } =
    useOrders(filters);
  const { data: origins } = useOrigensComanda();
  const originLabel = useMemo(() => {
    const byCodi = new Map(origins.map((origin) => [origin.codi, origin.nom]));
    return (codi: string) => byCodi.get(codi) ?? codi;
  }, [origins]);

  // Llistat en PDF (petició del client, 29/09/2026): TOTES les comandes
  // que compleixen els filtres actius, no només la pàgina de 20 visible —
  // es tornen a demanar totes a GET /comandes amb els mateixos filtres.
  const [isPrinting, setIsPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  const activeFilterLabels = [
    search.trim() && `Cerca: ${search.trim()}`,
    statusFilter !== ALL && `Estat: ${statusFilter}`,
    productionDateFilter && `Data producció: ${formatData(productionDateFilter, false)}`,
    orderDateFilter && `Data comanda: ${formatData(orderDateFilter, false)}`,
    deliveryDateFilter && `Data lliurament: ${formatData(deliveryDateFilter, false)}`,
  ].filter((label): label is string => Boolean(label));

  async function handlePrint() {
    setIsPrinting(true);
    setPrintError(null);
    try {
      const comandes = await obtenirTotesLesPagines((pagina) =>
        api.get<RespostaPaginada<ComandaResumApi>>('/comandes', { ...filters, mida: 200, pagina }),
      );
      await descarregarPdfLlistatComandes({
        comandes,
        filtres: activeFilterLabels,
        originLabel,
      });
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

  async function handleConfirmIncidence() {
    if (!incidenceTarget) return;
    setIsMarkingIncidence(true);
    setIncidenceError(null);
    try {
      await markIncidence(incidenceTarget.id, incidenceDetall.trim());
      setIncidenceTarget(null);
      setIncidenceDetall('');
    } catch (caught) {
      setIncidenceError(
        caught instanceof ApiError ? caught.message : "No s'ha pogut marcar la incidència.",
      );
    } finally {
      setIsMarkingIncidence(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Comandes"
        subtitle="Manteniment de comandes de venda."
        right={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handlePrint}
              disabled={isPrinting || isLoading || !paginacio || paginacio.total === 0}
              className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Printer className="h-4 w-4" />
              {isPrinting
                ? 'Generant PDF...'
                : `Imprimir llista de comandes (${paginacio?.total ?? 0})`}
            </button>
            <button
              type="button"
              onClick={() => router.push('/orders/new')}
              className="flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
            >
              Nova comanda
            </button>
          </div>
        }
      />
      {printError && <p className="-mt-6 mb-6 text-sm text-red-600">{printError}</p>}

      <FilterBar>
        <SearchInput label="Cerca (núm. comanda o client)" value={search} onChange={setSearch} />
        <SimpleDropdown
          label="Estat"
          options={Object.values(ESTAT_LABELS)}
          value={statusFilter}
          onChange={setStatusFilter}
          allLabel={ALL}
        />
        <DateInput
          label="Data producció"
          value={productionDateFilter}
          onChange={setProductionDateFilter}
        />
        <DateInput label="Data comanda" value={orderDateFilter} onChange={setOrderDateFilter} />
        <DateInput
          label="Data lliurament"
          value={deliveryDateFilter}
          onChange={setDeliveryDateFilter}
        />
      </FilterBar>

      {isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;han pogut carregar les comandes: {error.message}
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
            {data.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                originLabel={originLabel}
                onOpen={() => router.push(`/orders/${order.id}`)}
                onMarkIncidence={() => {
                  setIncidenceError(null);
                  setIncidenceDetall('');
                  setIncidenceTarget(order);
                }}
              />
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[8%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Núm.
                  </th>
                  <th className="w-[13%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Client
                  </th>
                  <th className="w-[9%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Origen
                  </th>
                  <th className="hidden w-[8%] px-2 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Tarifa
                  </th>
                  <th className="hidden w-[9%] px-2 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Data comanda
                  </th>
                  <th className="hidden w-[9%] px-2 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Data producció
                  </th>
                  <th className="w-[9%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Data lliurament
                  </th>
                  <th className="hidden w-[9%] px-2 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Transportista
                  </th>
                  <th className="hidden w-[6%] px-2 py-2 text-right font-medium text-gray-500 break-words xl:table-cell">
                    Bultos
                  </th>
                  <th className="w-[9%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Estat
                  </th>
                  <th className="w-[11%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Accions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((order) => (
                  <tr
                    key={order.id}
                    onClick={() => router.push(`/orders/${order.id}`)}
                    className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50"
                  >
                    <td className="px-2 py-3 break-words">
                      <span className="font-semibold text-gray-900">{order.num}</span>
                    </td>
                    <td className="px-2 py-3 break-words text-gray-900">
                      {order.client?.nom ?? '—'}
                    </td>
                    <td className="px-2 py-3 break-words">
                      <Badge variant={origenBadgeVariant(order.origen)}>
                        {originLabel(order.origen)}
                      </Badge>
                    </td>
                    <td className="hidden px-2 py-3 break-words text-gray-900 xl:table-cell">
                      {order.tarifa?.nom ?? '—'}
                    </td>
                    <td className="hidden px-2 py-3 break-words text-gray-900 xl:table-cell">
                      {formatData(order.dataComanda, false)}
                    </td>
                    <td className="hidden px-2 py-3 break-words text-gray-900 xl:table-cell">
                      {productionDates(order) || '—'}
                    </td>
                    <td className="px-2 py-3 break-words text-gray-900">
                      {order.dataLliurament ? formatData(order.dataLliurament, false) : '—'}
                    </td>
                    <td className="hidden px-2 py-3 break-words text-gray-900 xl:table-cell">
                      {order.transportista?.nom ?? '—'}
                    </td>
                    <td className="hidden px-2 py-3 text-right text-gray-900 xl:table-cell">
                      {order.bultos ?? '—'}
                    </td>
                    <td className="px-2 py-3 break-words">
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant={estatBadgeVariant(order.estat)}>
                          {ESTAT_LABELS[order.estat] ?? order.estat}
                        </Badge>
                        {order.congelada && <Badge variant="neutral">Congelada</Badge>}
                      </div>
                    </td>
                    <td className="px-2 py-3 text-right">
                      <div
                        onClick={(event) => event.stopPropagation()}
                        className="flex justify-end gap-1"
                      >
                        <IconButton
                          variant="edit"
                          label="Editar comanda"
                          onClick={() => router.push(`/orders/${order.id}`)}
                        />
                        {order.estat !== 'amb_incidencia' && order.estat !== 'cancellada' && (
                          <IconButton
                            variant="warning"
                            label="Marcar com a incidència"
                            onClick={() => {
                              setIncidenceError(null);
                              setIncidenceDetall('');
                              setIncidenceTarget(order);
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {paginacio && <Pagination paginacio={paginacio} onPageChange={setPagina} />}
        </>
      )}

      <ConfirmDialog
        isOpen={incidenceTarget !== null}
        title="Marcar com a incidència"
        message={`Vols marcar la comanda ${incidenceTarget?.num ?? ''} com a incidència?`}
        confirmLabel="Marcar"
        confirmingLabel="Marcant..."
        cancelLabel="Cancel·lar"
        errorMessage={incidenceError}
        isConfirming={isMarkingIncidence}
        detailField={{
          label: 'Motiu',
          value: incidenceDetall,
          onChange: setIncidenceDetall,
          placeholder: 'Explica per què es marca aquesta comanda com a incidència',
        }}
        onConfirm={handleConfirmIncidence}
        onCancel={() => {
          setIncidenceTarget(null);
          setIncidenceError(null);
          setIncidenceDetall('');
        }}
      />
    </div>
  );
}
