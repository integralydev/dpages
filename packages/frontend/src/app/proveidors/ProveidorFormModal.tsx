'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { TextField } from '@/components/ui/TextField';
import type { ProveidorFormValues } from '@/hooks/useProveidors';
import { ApiError, type ProveidorApi } from '@/lib/api';

/** Punt 55: alta i edició d'un proveïdor (de moment, només el nom). */
export function ProveidorFormModal({
  mode,
  initialData,
  isOpen,
  onClose,
  onSave,
}: {
  mode: 'create' | 'edit';
  initialData?: ProveidorApi;
  isOpen: boolean;
  onClose: () => void;
  onSave: (values: ProveidorFormValues) => Promise<void>;
}) {
  const [nom, setNom] = useState(initialData?.nom ?? '');
  const [nomError, setNomError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const nomInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    nomInputRef.current?.focus();
    if (mode === 'edit') nomInputRef.current?.select();
  }, [isOpen, mode]);

  async function handleSave() {
    const trimmedName = nom.trim();
    if (!trimmedName) {
      setNomError('El nom no pot estar buit.');
      return;
    }
    setNomError(undefined);
    setFormError(null);
    setIsSaving(true);
    try {
      await onSave({ nom: trimmedName });
    } catch (caught) {
      if (caught instanceof ApiError) {
        const detallNom = caught.detalls?.find((detall) => detall.camp === 'nom');
        if (detallNom) setNomError(detallNom.missatge);
        else setFormError(caught.message);
      } else {
        setFormError("No s'ha pogut desar el proveïdor.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'create' ? 'Nou proveïdor' : 'Modificar proveïdor'}
    >
      <div className="flex flex-col gap-4">
        <TextField
          ref={nomInputRef}
          label="Nom"
          value={nom}
          maxLength={100}
          onChange={(event) => setNom(event.target.value)}
          error={nomError}
        />
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
          disabled={isSaving}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSaving ? 'Desant...' : 'Desar'}
        </button>
      </div>
    </Modal>
  );
}
