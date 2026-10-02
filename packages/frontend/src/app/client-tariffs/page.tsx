'use client';

import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { DataCard, DataCardActions, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { FilterBar } from '@/components/ui/FilterBar';
import { IconButton } from '@/components/ui/IconButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SearchInput } from '@/components/ui/SearchInput';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { useClientTariffs, type ClientFormValues } from '@/hooks/useClientTariffs';
import { useRates } from '@/hooks/useRates';
import type { ClientApi } from '@/lib/api';
import { ClientFormModal } from './ClientFormModal';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

const ALL_FEM = 'Totes';

function ClientTariffCard({ client, onEdit }: { client: ClientApi; onEdit: () => void }) {
  return (
    <DataCard>
      <p className="font-semibold text-gray-900">{client.codi}</p>
      <p className="text-sm text-gray-500">{client.nom}</p>

      <div className="mt-3">
        <DataCardGrid>
          <DataCardField label="Població">{client.poblacio ?? '—'}</DataCardField>
          <DataCardField label="Tarifa assignada">
            {client.tarifa ? <Badge>{client.tarifa.nom}</Badge> : '—'}
          </DataCardField>
        </DataCardGrid>
      </div>

      <DataCardActions>
        <button
          type="button"
          onClick={onEdit}
          className="w-full rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Editar client
        </button>
      </DataCardActions>
    </DataCard>
  );
}

export default function ClientTariffsPage() {
  const [search, setSearch] = useState('');
  const [tariffFilter, setTariffFilter] = useState(ALL_FEM);
  const [formState, setFormState] = useState<{
    mode: 'create' | 'edit';
    client?: ClientApi;
  } | null>(null);

  // useRates() només per `tariffColumns` (llista completa, no paginada —
  // ver comentari a useRates.ts), no es toca `data` d'acá.
  const { tariffColumns } = useRates();

  const tariffFilterOptions = useMemo(
    () => [ALL_FEM, ...tariffColumns.map((tariff) => tariff.nom)],
    [tariffColumns],
  );
  const tarifaId = useMemo(
    () =>
      tariffFilter !== ALL_FEM
        ? tariffColumns.find((item) => item.nom === tariffFilter)?.id
        : undefined,
    [tariffFilter, tariffColumns],
  );

  // Migració server-side: `tariffFilter` es filtrava client-side sobre
  // `data` (només els 20 clients de la pàgina
  // actual) — `useClientTariffs()` mai detectava el canvi (no formava part
  // de `clientFilters`) i `pagina` no es resetejava mai. Ara viatja com a
  // `tarifaId` real (GET /clients?tarifaId=, confirmat contra clients.ts),
  // mateix criteri que `cerca` (ja server-side des d'abans).
  const clientFilters = useMemo(
    () => ({
      ...(search.trim() ? { cerca: search.trim() } : {}),
      ...(tarifaId !== undefined ? { tarifaId } : {}),
    }),
    [search, tarifaId],
  );
  const { data, paginacio, setPagina, isLoading, error, refetch, createClient, editClient } =
    useClientTariffs(clientFilters, { mida: MIDA_PAGINA_LLISTATS });

  async function handleSave(values: ClientFormValues) {
    if (formState?.mode === 'edit' && formState.client) {
      await editClient(formState.client.id, values);
    } else {
      await createClient(values);
    }
    setFormState(null);
  }

  return (
    <div>
      <PageHeader
        title="Tarifes per client"
        subtitle="Assignació de tarifes als clients."
        action={{
          label: 'Nou client',
          icon: <Plus className="h-4 w-4" />,
          onClick: () => setFormState({ mode: 'create' }),
        }}
      />

      <FilterBar>
        <SearchInput label="Cerca client (codi o nom)" value={search} onChange={setSearch} />
        <SimpleDropdown
          label="Tarifa"
          options={tariffFilterOptions}
          value={tariffFilter}
          onChange={setTariffFilter}
        />
      </FilterBar>

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
          <div className="flex flex-col gap-3 md:hidden">
            {data.map((client) => (
              <ClientTariffCard
                key={client.id}
                client={client}
                onEdit={() => setFormState({ mode: 'edit', client })}
              />
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[15%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Codi
                  </th>
                  <th className="w-[28%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Client
                  </th>
                  <th className="w-[20%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Població
                  </th>
                  <th className="w-[22%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Tarifa assignada
                  </th>
                  <th className="w-[15%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Accions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((client) => (
                  <tr key={client.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-2 py-3 break-words">
                      <span className="font-semibold text-gray-900">{client.codi}</span>
                    </td>
                    <td className="px-2 py-3 break-words text-gray-900">{client.nom}</td>
                    <td className="px-2 py-3 break-words text-gray-900">
                      {client.poblacio ?? '—'}
                    </td>
                    <td className="px-2 py-3 break-words">
                      {client.tarifa ? <Badge>{client.tarifa.nom}</Badge> : '—'}
                    </td>
                    <td className="px-2 py-3 text-right">
                      <div className="flex justify-end">
                        <IconButton
                          variant="edit"
                          label="Editar client"
                          onClick={() => setFormState({ mode: 'edit', client })}
                        />
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

      <ClientFormModal
        key={formState ? (formState.client?.id ?? 'create') : 'closed'}
        mode={formState?.mode ?? 'create'}
        initialData={formState?.client}
        tariffColumns={tariffColumns}
        isOpen={formState !== null}
        onClose={() => setFormState(null)}
        onSave={handleSave}
      />
    </div>
  );
}
