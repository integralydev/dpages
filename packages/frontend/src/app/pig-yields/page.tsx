'use client';

import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataCard, DataCardActions, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { EditableCell } from '@/components/ui/EditableCell';
import { ClearFiltersButton, FilterBar } from '@/components/ui/FilterBar';
import { IconButton } from '@/components/ui/IconButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { useCategories } from '@/hooks/useCategories';
import { useEditableRow } from '@/hooks/useEditableRow';
import { usePigYields, type PigYieldPatch } from '@/hooks/usePigYields';
import { ApiError, type RendimentPorcApi } from '@/lib/api';
import { parseDecimalInput } from '@/lib/decimals';
import { formatNombre } from '@/lib/decimals';
import { calculatePigYieldTotal } from '@/lib/pigYieldCalculations';
import { PigYieldFormModal } from './PigYieldFormModal';

const ALL_CATEGORIES = 'Totes';

function formatUnits(value: number) {
  return formatNombre(value, 2);
}

function formatKg(value: number) {
  return formatNombre(value, 3);
}

function PigYieldRow({
  item,
  onSave,
  onDelete,
}: {
  item: RendimentPorcApi;
  onSave: (id: number, patch: PigYieldPatch) => Promise<void>;
  onDelete: (item: RendimentPorcApi) => void;
}) {
  const [rowError, setRowError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const { draft, setField, save, isDirty } = useEditableRow(
    { unitsPerPig: Number(item.unitatsPerPorc), kgPerUnit: Number(item.kgPerUnitat) },
    async (values) => {
      setIsSaving(true);
      setRowError(null);
      try {
        await onSave(item.id, {
          unitatsPerPorc: parseDecimalInput(values.unitsPerPig, 2),
          kgPerUnitat: parseDecimalInput(values.kgPerUnit, 3),
        });
      } catch (caught) {
        setRowError(caught instanceof ApiError ? caught.message : "No s'ha pogut desar la línia.");
      } finally {
        setIsSaving(false);
      }
    },
  );

  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="px-2 py-3 break-words">
        <span className="font-semibold text-gray-900">{item.categoria}</span>
      </td>
      <td className="px-2 py-3 break-words text-gray-900">{item.agrupacioProduccio}</td>
      <td className="px-2 py-3 text-right">
        <EditableCell
          value={draft.unitsPerPig}
          formatValue={formatUnits}
          onChange={(value) => setField('unitsPerPig', value ?? 0)}
        />
      </td>
      <td className="px-2 py-3 text-right">
        <EditableCell
          value={draft.kgPerUnit}
          formatValue={formatKg}
          onChange={(value) => setField('kgPerUnit', value ?? 0)}
        />
      </td>
      <td className="px-2 py-3 text-right">
        <span className="font-bold text-gray-900">
          {formatKg(calculatePigYieldTotal(draft.unitsPerPig, draft.kgPerUnit))}
        </span>
      </td>
      <td className="px-2 py-3 text-right">
        <div className="flex justify-end gap-1">
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
          <IconButton variant="delete" label="Suprimeix línia" onClick={() => onDelete(item)} />
        </div>
        {rowError && <p className="mt-1 text-right text-xs text-red-600">{rowError}</p>}
      </td>
    </tr>
  );
}

function PigYieldCard({
  item,
  onSave,
  onDelete,
}: {
  item: RendimentPorcApi;
  onSave: (id: number, patch: PigYieldPatch) => Promise<void>;
  onDelete: (item: RendimentPorcApi) => void;
}) {
  const [cardError, setCardError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const { draft, setField, save, isDirty } = useEditableRow(
    { unitsPerPig: Number(item.unitatsPerPorc), kgPerUnit: Number(item.kgPerUnitat) },
    async (values) => {
      setIsSaving(true);
      setCardError(null);
      try {
        await onSave(item.id, {
          unitatsPerPorc: parseDecimalInput(values.unitsPerPig, 2),
          kgPerUnitat: parseDecimalInput(values.kgPerUnit, 3),
        });
      } catch (caught) {
        setCardError(caught instanceof ApiError ? caught.message : "No s'ha pogut desar la línia.");
      } finally {
        setIsSaving(false);
      }
    },
  );

  return (
    <DataCard>
      <p className="font-semibold text-gray-900">{item.categoria}</p>
      <p className="text-sm text-gray-500">{item.agrupacioProduccio}</p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-xs text-gray-500">Unitats per porc</p>
          <EditableCell
            value={draft.unitsPerPig}
            formatValue={formatUnits}
            onChange={(value) => setField('unitsPerPig', value ?? 0)}
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-gray-500">Kg per unitat</p>
          <EditableCell
            value={draft.kgPerUnit}
            formatValue={formatKg}
            onChange={(value) => setField('kgPerUnit', value ?? 0)}
          />
        </div>
      </div>

      <div className="mt-3">
        <DataCardGrid columns={1}>
          <DataCardField label="Pes Total">
            <span className="font-bold text-gray-900">
              {formatKg(calculatePigYieldTotal(draft.unitsPerPig, draft.kgPerUnit))}
            </span>
          </DataCardField>
        </DataCardGrid>
      </div>

      {cardError && <p className="mt-2 text-xs text-red-600">{cardError}</p>}

      <DataCardActions>
        <button
          type="button"
          onClick={save}
          disabled={!isDirty || isSaving}
          className={`flex-1 rounded-full px-3 py-2 text-sm font-semibold ${
            isDirty && !isSaving
              ? 'bg-ink text-white hover:opacity-90'
              : 'cursor-not-allowed bg-gray-200 text-gray-400'
          }`}
        >
          {isSaving ? 'Desant...' : 'Desar'}
        </button>
        <IconButton variant="delete" label="Suprimeix línia" onClick={() => onDelete(item)} />
      </DataCardActions>
    </DataCard>
  );
}

export default function PigYieldsPage() {
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES);
  const {
    data,
    paginacio,
    setPagina,
    isLoading,
    error,
    refetch,
    createPigYield,
    updatePigYield,
    deletePigYield,
  } = usePigYields(categoryFilter === ALL_CATEGORIES ? {} : { categoria: categoryFilter });
  // El filtre `?categoria=` és real i server-side (GET /rendiments-porcs,
  // confirmat amb curl) — les opcions del desplegable NO poden sortir de
  // `data`, perquè un cop filtrat `data` només conté el subconjunt triat i
  // les altres categories desapareixerien de la llista d'opcions. Surten de
  // useCategories() (només les que tenen agrupacioRendiment definit, mateix
  // criteri que exigeix el POST).
  const { data: categories } = useCategories();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [pigYieldToDelete, setPigYieldToDelete] = useState<RendimentPorcApi | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const categoryOptions = useMemo(
    () => categories.filter((c) => c.agrupacioRendiment !== null).map((c) => c.nom),
    [categories],
  );

  async function handleConfirmDelete() {
    if (!pigYieldToDelete) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deletePigYield(pigYieldToDelete.id);
      setPigYieldToDelete(null);
    } catch (caught) {
      setDeleteError(
        caught instanceof ApiError ? caught.message : "No s'ha pogut eliminar la línia.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Rendiments Porcs"
        subtitle="Edita les cel·les i prem Desar a la fila per confirmar els canvis."
        action={{
          label: 'Nova línia',
          icon: <Plus className="h-4 w-4" />,
          onClick: () => setIsModalOpen(true),
        }}
      />

      <FilterBar>
        <SimpleDropdown
          label="Categoria"
          allLabel={ALL_CATEGORIES}
          options={categoryOptions}
          value={categoryFilter}
          onChange={setCategoryFilter}
        />
        <ClearFiltersButton onClick={() => setCategoryFilter(ALL_CATEGORIES)} />
      </FilterBar>

      {isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;han pogut carregar els rendiments: {error.message}
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
            {data.map((item) => (
              <PigYieldCard
                key={item.id}
                item={item}
                onSave={updatePigYield}
                onDelete={setPigYieldToDelete}
              />
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[14%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Categoria
                  </th>
                  <th className="w-[22%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Agrupació Producció
                  </th>
                  <th className="w-[14%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Unitats per porc
                  </th>
                  <th className="w-[14%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Kg per unitat
                  </th>
                  <th className="w-[14%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Pes Total
                  </th>
                  <th className="w-[22%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Accions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((item) => (
                  <PigYieldRow
                    key={item.id}
                    item={item}
                    onSave={updatePigYield}
                    onDelete={setPigYieldToDelete}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {paginacio && <Pagination paginacio={paginacio} onPageChange={setPagina} />}
        </>
      )}

      <PigYieldFormModal
        key={isModalOpen ? 'open' : 'closed'}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={async (values) => {
          await createPigYield(values);
          setIsModalOpen(false);
        }}
      />

      <ConfirmDialog
        isOpen={pigYieldToDelete !== null}
        title="Suprimeix línia"
        message={
          pigYieldToDelete
            ? `Estàs segur que vols suprimir la línia "${pigYieldToDelete.categoria} · ${pigYieldToDelete.agrupacioProduccio}"? Aquesta acció no es pot desfer.`
            : ''
        }
        confirmLabel="Eliminar"
        cancelLabel="Cancel·lar"
        errorMessage={deleteError}
        isConfirming={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setPigYieldToDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
