'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataCard, DataCardActions } from '@/components/ui/DataCard';
import { IconButton } from '@/components/ui/IconButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { useProveidors, type ProveidorFormValues } from '@/hooks/useProveidors';
import { ApiError, type ProveidorApi } from '@/lib/api';
import { ProveidorFormModal } from './ProveidorFormModal';

/**
 * Punt 55 (reformulat amb el client, 18/11/2026): manteniment de
 * proveïdors. Es poden esborrar del tot, però el backend no ho deixa fer si
 * algun article o línia de comanda el fa servir (i diu quants).
 */
export default function ProveidorsPage() {
  const { data, isLoading, error, refetch, createProveidor, editProveidor, deleteProveidor } =
    useProveidors();
  const [formState, setFormState] = useState<{
    mode: 'create' | 'edit';
    proveidor?: ProveidorApi;
  } | null>(null);
  const [toDelete, setToDelete] = useState<ProveidorApi | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleSave(values: ProveidorFormValues) {
    if (formState?.mode === 'edit' && formState.proveidor) {
      await editProveidor(formState.proveidor.id, values);
    } else {
      await createProveidor(values);
    }
    setFormState(null);
  }

  async function handleDelete() {
    if (!toDelete) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteProveidor(toDelete.id);
      setToDelete(null);
    } catch (caught) {
      setDeleteError(
        caught instanceof ApiError ? caught.message : "No s'ha pogut esborrar el proveïdor.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  function askDelete(proveidor: ProveidorApi) {
    setDeleteError(null);
    setToDelete(proveidor);
  }

  return (
    <div>
      <PageHeader
        title="Proveïdors"
        subtitle="Proveïdors per assignar als articles i a les línies de comanda."
        action={{
          label: 'Nou proveïdor',
          icon: <Plus className="h-4 w-4" />,
          onClick: () => setFormState({ mode: 'create' }),
        }}
      />

      {isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;han pogut carregar els proveïdors: {error.message}
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

      {!isLoading && !error && data.length === 0 && (
        <p className="text-sm text-gray-500">Encara no hi ha cap proveïdor.</p>
      )}

      {!isLoading && !error && data.length > 0 && (
        <>
          <div className="flex flex-col gap-3 md:hidden">
            {data.map((proveidor) => (
              <DataCard key={proveidor.id}>
                <p className="font-semibold text-gray-900">{proveidor.nom}</p>
                <DataCardActions>
                  <button
                    type="button"
                    onClick={() => setFormState({ mode: 'edit', proveidor })}
                    className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => askDelete(proveidor)}
                    className="flex-1 rounded-full border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                  >
                    Esborrar
                  </button>
                </DataCardActions>
              </DataCard>
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[80%] px-3 py-2 text-left font-medium text-gray-500 break-words">
                    Nom
                  </th>
                  <th className="w-[20%] px-3 py-2 text-right font-medium text-gray-500 break-words">
                    Accions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((proveidor) => (
                  <tr key={proveidor.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-3 break-words">
                      <span className="font-semibold text-gray-900">{proveidor.nom}</span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <IconButton
                          variant="edit"
                          label="Editar proveïdor"
                          onClick={() => setFormState({ mode: 'edit', proveidor })}
                        />
                        <IconButton
                          variant="delete"
                          label="Esborrar proveïdor"
                          onClick={() => askDelete(proveidor)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ProveidorFormModal
        key={formState ? (formState.proveidor?.id ?? 'create') : 'closed'}
        mode={formState?.mode ?? 'create'}
        initialData={formState?.proveidor}
        isOpen={formState !== null}
        onClose={() => setFormState(null)}
        onSave={handleSave}
      />

      <ConfirmDialog
        isOpen={toDelete !== null}
        title="Esborrar proveïdor"
        message={`Segur que vols esborrar «${toDelete?.nom ?? ''}»? No es pot desfer. Si algun article o línia de comanda el fa servir, no s'esborrarà.`}
        confirmLabel="Esborrar"
        confirmingLabel="Esborrant..."
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
        errorMessage={deleteError}
        isConfirming={isDeleting}
      />
    </div>
  );
}
