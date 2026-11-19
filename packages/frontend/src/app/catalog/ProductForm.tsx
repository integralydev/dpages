'use client';

import { useState } from 'react';
import { DecimalInput } from '@/components/ui/DecimalInput';
import { SelectFilter } from '@/components/ui/SelectFilter';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { useProveidors } from '@/hooks/useProveidors';
import { TextField } from '@/components/ui/TextField';
import { useCategories } from '@/hooks/useCategories';
import type { ProductFormValues } from '@/hooks/useCatalog';
import { ApiError, type ProducteApi } from '@/lib/api';
import { parseDecimalInput } from '@/lib/decimals';

const STATUS_OPTIONS = ['Actiu', 'Inactiu'];
// "Sense especificar" — mateix criteri que NO_CATEGORY: categories que no
// són de porc (vedella, pollastre, producte de botiga) no tenen Format ni
// Envasat real i no s'ha de forçar cap valor fals només perquè el select
// no oferia cap escapatòria (base i backend ja accepten NULL als dos
// camps, confirmat contra l'esquema real).
const NO_FORMAT = 'Sense especificar';
const NO_PACKAGING = 'Sense especificar';
const FORMAT_OPTIONS = [NO_FORMAT, 'SENCER', 'TALLAT', 'LLESCAT'];
const PACKAGING_OPTIONS = [NO_PACKAGING, 'NORMAL', 'ESPECIAL', 'NORMAL (web)', 'NORMAL (pes)'];
const NO_CATEGORY = 'Selecciona...';

type FieldErrors = {
  descripcio?: string;
  categoriaId?: string;
  format?: string;
  envasat?: string;
  proveidorDefecteId?: string;
};

const NO_PROVEIDOR = 'Sense proveïdor';

export function ProductForm({
  initialData,
  onSave,
  onCancel,
}: {
  initialData?: ProducteApi;
  onSave: (values: ProductFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const { data: categories } = useCategories();
  // Punt 55: proveïdor preferit de l'article (opcional).
  const { data: proveidors } = useProveidors();
  const [proveidor, setProveidor] = useState(initialData?.proveidorDefecte ?? null);
  const [proveidorTocat, setProveidorTocat] = useState(false);
  // El preferit actual sempre és a la llista, encara que no hagi carregat.
  const opcionsProveidor =
    proveidor && !proveidors.some((p) => p.id === proveidor.id)
      ? [proveidor, ...proveidors]
      : proveidors;
  const [codi, setCodi] = useState(initialData?.codi ?? '');
  const [agrupacioProduccio, setAgrupacioProduccio] = useState(
    initialData?.agrupacioProduccio ?? '',
  );
  const [actiu, setActiu] = useState<string>(initialData?.actiu === false ? 'Inactiu' : 'Actiu');
  const [descripcio, setDescripcio] = useState(initialData?.descripcio ?? '');
  const [categoriaNom, setCategoriaNom] = useState(initialData?.categoria?.nom ?? NO_CATEGORY);
  // null per defecte (no "SENCER"/"NORMAL"): mateix criteri que Categoria,
  // que ja arranca en NO_CATEGORY en comptes de triar-ne una a l'atzar.
  const [format, setFormat] = useState<ProducteApi['format']>(initialData?.format ?? null);
  const [envasat, setEnvasat] = useState<ProducteApi['envasat']>(initialData?.envasat ?? null);
  const [pesKg, setPesKg] = useState(
    initialData?.pesKg !== null ? (initialData?.pesKg ?? '0') : '0',
  );
  const [preuVenda, setPreuVenda] = useState(initialData?.preuVenda ?? '0');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const canSave = descripcio.trim() !== '';

  async function handleSave() {
    if (!canSave) return;
    const categoria = categories.find((item) => item.nom === categoriaNom) ?? null;
    setFieldErrors({});
    setFormError(null);
    setIsSaving(true);
    try {
      await onSave({
        codi: codi.trim() || null,
        descripcio: descripcio.trim(),
        descripcioVenda: initialData?.descripcioVenda ?? null,
        agrupacioProduccio: agrupacioProduccio.trim() || null,
        actiu: actiu === 'Actiu',
        categoriaId: categoria?.id ?? null,
        format,
        envasat,
        pesKg: Number(pesKg) > 0 ? parseDecimalInput(pesKg, 3) : null,
        preuVenda: Number(preuVenda) > 0 ? parseDecimalInput(preuVenda, 2) : null,
        ...(proveidorTocat ? { proveidorDefecteId: proveidor?.id ?? null } : {}),
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        const nextFieldErrors: FieldErrors = {};
        for (const detall of caught.detalls ?? []) {
          if (
            detall.camp === 'descripcio' ||
            detall.camp === 'categoriaId' ||
            detall.camp === 'format' ||
            detall.camp === 'envasat' ||
            detall.camp === 'proveidorDefecteId'
          ) {
            nextFieldErrors[detall.camp] = detall.missatge;
          }
        }
        if (Object.keys(nextFieldErrors).length > 0) {
          setFieldErrors(nextFieldErrors);
        } else {
          setFormError(caught.message);
        }
      } else {
        setFormError("No s'ha pogut desar el producte.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {initialData !== undefined ? (
            // Issue de robustesa — codi és immutable un cop creat
            // (decisió de negoci confirmada): en edició es mostra com a text
            // de sòl lectura, mateix component/classes exactes que "Codi" a
            // ClientFormModal.tsx (mai un TextField disabled, que es veuria
            // com un input editable qualsevol).
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-900">Codi de producte</span>
              <span className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-gray-500">
                {initialData?.codi ?? '—'}
              </span>
            </div>
          ) : (
            <TextField
              label="Codi de producte"
              value={codi}
              onChange={(event) => setCodi(event.target.value)}
            />
          )}
          <TextField
            label="Agrupació producció"
            value={agrupacioProduccio}
            onChange={(event) => setAgrupacioProduccio(event.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectFilter label="Estat" options={STATUS_OPTIONS} value={actiu} onChange={setActiu} />
          <div>
            <SimpleDropdown
              label="Categoria"
              options={[NO_CATEGORY, ...categories.map((item) => item.nom)]}
              value={categoriaNom}
              onChange={setCategoriaNom}
            />
            {fieldErrors.categoriaId && (
              <p className="mt-1.5 text-xs text-red-600">{fieldErrors.categoriaId}</p>
            )}
          </div>
        </div>

        <TextField
          label="Descripció"
          value={descripcio}
          onChange={(event) => setDescripcio(event.target.value)}
          error={fieldErrors.descripcio}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <SimpleDropdown
              label="Format"
              options={FORMAT_OPTIONS}
              value={format ?? NO_FORMAT}
              onChange={(value) =>
                setFormat(value === NO_FORMAT ? null : (value as ProducteApi['format']))
              }
            />
            {fieldErrors.format && (
              <p className="mt-1.5 text-xs text-red-600">{fieldErrors.format}</p>
            )}
          </div>
          <div>
            <SimpleDropdown
              label="Envasat"
              options={PACKAGING_OPTIONS}
              value={envasat ?? NO_PACKAGING}
              onChange={(value) =>
                setEnvasat(value === NO_PACKAGING ? null : (value as ProducteApi['envasat']))
              }
            />
            {fieldErrors.envasat && (
              <p className="mt-1.5 text-xs text-red-600">{fieldErrors.envasat}</p>
            )}
          </div>
        </div>

        <div>
          <SimpleDropdown
            label="Proveïdor preferit"
            options={[NO_PROVEIDOR, ...opcionsProveidor.map((p) => p.nom)]}
            value={proveidor?.nom ?? NO_PROVEIDOR}
            onChange={(nom) => {
              const triat = opcionsProveidor.find((p) => p.nom === nom);
              setProveidor(triat ? { id: triat.id, nom: triat.nom } : null);
              setProveidorTocat(true);
            }}
          />
          {fieldErrors.proveidorDefecteId && (
            <p className="mt-1.5 text-xs text-red-600">{fieldErrors.proveidorDefecteId}</p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <DecimalInput label="Pes (kg)" value={pesKg} onChange={setPesKg} />
          <DecimalInput label="Preu base (€)" value={preuVenda} onChange={setPreuVenda} />
        </div>

        {formError && <p className="text-sm text-red-600">{formError}</p>}
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-gray-200 pt-6">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-gray-500 hover:text-gray-700"
        >
          Cancel·lar
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave || isSaving}
          className={`rounded-full px-5 py-2.5 text-sm font-semibold ${
            canSave && !isSaving
              ? 'bg-ink text-white hover:opacity-90'
              : 'cursor-not-allowed bg-gray-200 text-gray-400'
          }`}
        >
          {isSaving ? 'Desant...' : 'Desar'}
        </button>
      </div>
    </div>
  );
}
