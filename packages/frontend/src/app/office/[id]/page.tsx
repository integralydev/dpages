'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { DataCard, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { ESTAT_LABELS, estatBadgeVariant } from '@/lib/comandaEstat';
import { api, ApiError, type ComandaDetallApi, type ComandaLiniaApi } from '@/lib/api';
import { formatData } from '@/lib/dates';
import { formatDecimal } from '@/lib/decimals';

function formatPrice(value: string) {
  return `${formatDecimal(value, 2)} €`;
}

function formatKg(value: string) {
  return formatDecimal(value, 3);
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-sm text-gray-900">{value}</p>
    </div>
  );
}

function OrderLineCard({ line }: { line: ComandaLiniaApi }) {
  return (
    <DataCard>
      <p className="font-semibold text-gray-900">
        {line.producte
          ? `${line.producte.codi ?? line.producte.id} · ${line.producte.descripcio}`
          : '—'}
      </p>
      <p className="text-sm text-gray-500">{line.format ?? '—'}</p>

      <div className="mt-3">
        <DataCardGrid>
          <DataCardField label="Unitats demanades">
            {formatDecimal(line.unitatsDemanades, 2)}
          </DataCardField>
          <DataCardField label="Unitats lliurades">
            {formatDecimal(line.unitatsLliurades, 2)}
          </DataCardField>
          <DataCardField label="Pes demanat (kg)">{formatKg(line.kgDemanats)}</DataCardField>
          <DataCardField label="Pes lliurat (kg)">{formatKg(line.kgLliurats)}</DataCardField>
          <DataCardField label="Preu unitari">{formatPrice(line.preuUnitari)}</DataCardField>
          <DataCardField label="Subtotal">
            <span className="font-semibold">{formatPrice(line.totalLinia)}</span>
          </DataCardField>
        </DataCardGrid>
      </div>

      <label className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={(line.obsProduccio ?? '').trim().length > 0}
          disabled
          className="h-4 w-4 rounded border-gray-300 text-ink"
        />
        Obs. producció
      </label>
    </DataCard>
  );
}

export default function OfficeOrderDetailPage() {
  const params = useParams<{ id: string }>();

  const [order, setOrder] = useState<ComandaDetallApi | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Mateix criteri que orders/[id]/page.tsx: es demana per id directe (GET
  // /comandes/:id) — Panell Oficina és sólo lectura, no fa falta cap
  // mutation acá, però la pantalla comparteix el mateix endpoint ja
  // connectat.
  useEffect(() => {
    let cancelled = false;
    // Fetch a un sistema extern (API): el reset síncron d'isLoading/error
    // just abans de cridar-lo és el patró de React per a data fetching en
    // efectes, no un valor derivable durant el render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setLoadError(null);

    api
      .get<ComandaDetallApi>(`/comandes/${params.id}`)
      .then((resposta) => {
        if (!cancelled) setOrder(resposta);
      })
      .catch((caught) => {
        if (!cancelled) {
          setLoadError(
            caught instanceof ApiError
              ? caught
              : new ApiError('ERROR_XARXA', 'Error desconegut.', null),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [params.id, reloadToken]);

  return (
    <div>
      <div className="mb-8 flex items-center gap-4">
        <Link
          href="/office"
          className="flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Tornar
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 lg:text-3xl">
          Comanda {order?.num ?? params.id}
        </h1>
      </div>

      {isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {loadError && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;ha pogut carregar la comanda: {loadError.message}
          </p>
          <button
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
            className="shrink-0 rounded-full border border-red-300 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            Torna-ho a provar
          </button>
        </div>
      )}

      {order && (
        <div className="flex flex-col gap-6">
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <h2 className="mb-4 text-base font-bold text-gray-900">Capçalera</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Núm. comanda" value={order.num} />
              <Field
                label="Estat"
                value={
                  <Badge variant={estatBadgeVariant(order.estat)}>
                    {ESTAT_LABELS[order.estat] ?? order.estat}
                  </Badge>
                }
              />
              <Field label="Client" value={order.client?.nom ?? '—'} />
              <Field label="Població de destí" value={order.poblacioDesti || '—'} />
              <Field label="Tarifa" value={order.tarifa?.nom ?? '—'} />
              <Field label="Transportista" value={order.transportista?.nom ?? '—'} />
              <Field label="Data comanda" value={formatData(order.dataComanda, false)} />
              <Field
                label="Data lliurament"
                value={order.dataLliurament ? formatData(order.dataLliurament, false) : '—'}
              />
              <Field
                label="Data expedició"
                value={order.dataExpedicio ? formatData(order.dataExpedicio, false) : '—'}
              />
              <Field label="Núm. bultos" value={order.bultos ?? '—'} />
            </div>

            <div className="mt-4">
              <Field label="Adreça de lliurament" value={order.adrecaLliurament || '—'} />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Observacions de producció globals" value={order.obsProduccio || '—'} />
              <Field label="Observacions de lliurament" value={order.obsLliurament || '—'} />
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <h2 className="mb-4 text-base font-bold text-gray-900">Línies</h2>

            <div className="flex flex-col gap-3 xl:hidden">
              {order.linies.map((line) => (
                <OrderLineCard key={line.id} line={line} />
              ))}
            </div>

            <div className="hidden overflow-x-auto rounded-lg border border-gray-200 xl:block">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-500 break-words">
                      Producte
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500 break-words">
                      Format
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Unitats demanades
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Unitats lliurades
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Pes demanat (kg)
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Pes lliurat (kg)
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Preu unitari
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-gray-500 break-words">
                      Subtotal
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500 break-words">
                      Obs. producció
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {order.linies.map((line) => (
                    <tr key={line.id} className="border-b border-gray-100 last:border-0">
                      <td className="px-3 py-2 break-words text-gray-900">
                        {line.producte
                          ? `${line.producte.codi ?? line.producte.id} · ${line.producte.descripcio}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 break-words text-gray-500">{line.format ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-gray-900">
                        {formatDecimal(line.unitatsDemanades, 2)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-900">
                        {formatDecimal(line.unitatsLliurades, 2)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-900">
                        {formatKg(line.kgDemanats)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-900">
                        {formatKg(line.kgLliurats)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-900">
                        {formatPrice(line.preuUnitari)}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-gray-900">
                        {formatPrice(line.totalLinia)}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={(line.obsProduccio ?? '').trim().length > 0}
                          disabled
                          className="h-4 w-4 rounded border-gray-300 text-ink"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
