'use client';

import { Modal } from '@/components/ui/Modal';

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirmar',
  confirmingLabel = 'Eliminant...',
  cancelLabel = 'Cancel·lar',
  onConfirm,
  onCancel,
  errorMessage,
  isConfirming,
  detailField,
}: {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  /** Texto del botón de confirmar mientras isConfirming es true — por defecto asume una eliminación (uso histórico más común de este diálogo). */
  confirmingLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Mensaje de error de la última confirmación fallida (ej. 409 CONFLICTE del backend) — se muestra dentro del propio diálogo, sin cerrarlo. */
  errorMessage?: string | null;
  /** Deshabilita el botón de confirmar mientras la acción está en curso — evita doble click/doble request. */
  isConfirming?: boolean;
  /** Campo de texto adicional dentro del diálogo (ej. motivo obligatorio al marcar incidència) — si se pasa, el botón de confirmar queda deshabilitado mientras value esté vacío. */
  detailField?: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
}) {
  const detailMissing = detailField !== undefined && detailField.value.trim() === '';

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title}>
      <p className="text-sm text-gray-600">{message}</p>
      {detailField && (
        <label className="mt-4 flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-gray-900">{detailField.label}</span>
          <textarea
            value={detailField.value}
            onChange={(event) => detailField.onChange(event.target.value)}
            placeholder={detailField.placeholder}
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none"
          />
        </label>
      )}
      {errorMessage && <p className="mt-3 text-sm text-red-600">{errorMessage}</p>}
      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-gray-500 hover:text-gray-700"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isConfirming || detailMissing}
          className="rounded-full bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isConfirming ? confirmingLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
