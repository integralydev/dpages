'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { DataCard, DataCardActions, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { IconButton } from '@/components/ui/IconButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { useCarriers } from '@/hooks/useCarriers';
import type { TransportistaApi } from '@/lib/api';
import { TransportistFormModal } from './TransportistFormModal';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

function CarrierCard({ carrier, onEdit }: { carrier: TransportistaApi; onEdit: () => void }) {
  return (
    <DataCard>
      <p className="font-semibold text-gray-900">{carrier.nom}</p>

      <div className="mt-3">
        <DataCardGrid>
          <DataCardField label="Actiu">{carrier.actiu ? 'Sí' : 'No'}</DataCardField>
        </DataCardGrid>
      </div>

      <DataCardActions>
        <button
          type="button"
          onClick={onEdit}
          className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Editar transportista
        </button>
      </DataCardActions>
    </DataCard>
  );
}

export default function TransportistesPage() {
  const { data, paginacio, setPagina, isLoading, error, refetch, createCarrier, editCarrier } =
    useCarriers({
      mida: MIDA_PAGINA_LLISTATS,
    });
  const [formState, setFormState] = useState<{
    mode: 'create' | 'edit';
    carrier?: TransportistaApi;
  } | null>(null);

  async function handleSave(values: { nom: string }) {
    if (formState?.mode === 'edit' && formState.carrier) {
      await editCarrier(formState.carrier.id, values);
    } else {
      await createCarrier(values);
    }
    setFormState(null);
  }

  return (
    <div>
      <PageHeader
        title="Transportistes"
        subtitle="Manteniment dels transportistes disponibles per assignar a les comandes."
        action={{
          label: 'Nou transportista',
          icon: <Plus className="h-4 w-4" />,
          onClick: () => setFormState({ mode: 'create' }),
        }}
      />

      {isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;han pogut carregar els transportistes: {error.message}
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
            {data.map((carrier) => (
              <CarrierCard
                key={carrier.id}
                carrier={carrier}
                onEdit={() => setFormState({ mode: 'edit', carrier })}
              />
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[70%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Nom
                  </th>
                  <th className="w-[15%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Actiu
                  </th>
                  <th className="w-[15%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Accions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((carrier) => (
                  <tr key={carrier.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-3 break-words">
                      <span className="font-semibold text-gray-900">{carrier.nom}</span>
                    </td>
                    <td className="px-3 py-3 break-words text-gray-900">
                      {carrier.actiu ? 'Sí' : 'No'}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <IconButton
                          variant="edit"
                          label="Editar transportista"
                          onClick={() => setFormState({ mode: 'edit', carrier })}
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

      <TransportistFormModal
        key={formState ? (formState.carrier?.id ?? 'create') : 'closed'}
        mode={formState?.mode ?? 'create'}
        initialData={formState?.carrier}
        isOpen={formState !== null}
        onClose={() => setFormState(null)}
        onSave={handleSave}
      />
    </div>
  );
}
