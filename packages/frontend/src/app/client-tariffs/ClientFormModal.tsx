'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { TextField } from '@/components/ui/TextField';
import type { ClientFormValues } from '@/hooks/useClientTariffs';
import { ApiError, type ClientApi, type TarifaResumApi } from '@/lib/api';
import { TIPUS_CLIENT_LABELS, TIPUS_CLIENT_OPTIONS, tipusClientPerLabel } from '@/lib/tipusClient';

const NO_TARIFF = 'Sense tarifa';

// codi no es editable acá: el backend lo autogenera siempre, así que un
// error de ese campo no tiene dónde mostrarse junto a un input
// — cae al mensaje genérico.
type FieldErrors = { nom?: string; poblacio?: string; tarifaId?: string; tipus?: string };

export function ClientFormModal({
  mode,
  initialData,
  tariffColumns,
  isOpen,
  onClose,
  onSave,
}: {
  mode: 'create' | 'edit';
  initialData?: ClientApi;
  tariffColumns: TarifaResumApi[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (values: ClientFormValues) => Promise<void>;
}) {
  const [poblacio, setPoblacio] = useState(initialData?.poblacio ?? '');
  const [nom, setNom] = useState(initialData?.nom ?? '');
  const [tariffName, setTariffName] = useState(initialData?.tarifa?.nom ?? NO_TARIFF);
  // Punt 35: per defecte, esporàdic (com al backend).
  const [tipusLabel, setTipusLabel] = useState(
    TIPUS_CLIENT_LABELS[initialData?.tipus ?? 'esporadic'],
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const canSave = nom.trim() !== '' && poblacio.trim() !== '';

  async function handleSave() {
    if (!canSave) return;
    const tarifa = tariffColumns.find((tariff) => tariff.nom === tariffName) ?? null;
    setFieldErrors({});
    setFormError(null);
    setIsSaving(true);
    try {
      await onSave({
        nom: nom.trim(),
        poblacio: poblacio.trim(),
        tarifaId: tarifa?.id ?? null,
        nif: initialData?.nif ?? null,
        email: initialData?.email ?? null,
        telefon: initialData?.telefon ?? null,
        tipus: tipusClientPerLabel(tipusLabel) ?? 'esporadic',
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        const nextFieldErrors: FieldErrors = {};
        for (const detall of caught.detalls ?? []) {
          if (
            detall.camp === 'nom' ||
            detall.camp === 'poblacio' ||
            detall.camp === 'tarifaId' ||
            detall.camp === 'tipus'
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
        setFormError("No s'ha pogut desar el client.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'create' ? 'Nou client' : 'Modificar client'}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {mode === 'edit' && (
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-900">Codi</span>
              <span className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-gray-500">
                {initialData?.codi ?? '—'}
              </span>
            </div>
          )}
          <div className={mode === 'create' ? 'sm:col-span-2' : undefined}>
            <TextField
              label="Població"
              value={poblacio}
              onChange={(event) => setPoblacio(event.target.value)}
              error={fieldErrors.poblacio}
            />
          </div>
        </div>
        <TextField
          label="Nom"
          value={nom}
          onChange={(event) => setNom(event.target.value)}
          error={fieldErrors.nom}
        />
        <div>
          <SimpleDropdown
            label="Tarifa"
            options={[NO_TARIFF, ...tariffColumns.map((tariff) => tariff.nom)]}
            value={tariffName}
            onChange={setTariffName}
          />
          {fieldErrors.tarifaId && (
            <p className="mt-1.5 text-xs text-red-600">{fieldErrors.tarifaId}</p>
          )}
        </div>
        <div>
          <SimpleDropdown
            label="Tipus de client"
            options={TIPUS_CLIENT_OPTIONS.map((opcio) => opcio.label)}
            value={tipusLabel}
            onChange={setTipusLabel}
          />
          {fieldErrors.tipus && <p className="mt-1.5 text-xs text-red-600">{fieldErrors.tipus}</p>}
        </div>
        {formError && <p className="text-sm text-red-600">{formError}</p>}
      </div>
      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onClose}
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
    </Modal>
  );
}
