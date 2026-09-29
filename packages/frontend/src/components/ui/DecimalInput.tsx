'use client';

import { forwardRef } from 'react';

/**
 * <input type="number"> nativo exige punt com a separador decimal sense
 * importar el locale del sistema — en molts entorns (locale del navegador
 * en anglès, típic en màquines de desenvolupament) directament rebutja la
 * coma en teclejar. Aquest input és sempre type="text": mostra amb coma,
 * converteix a punt cap enfora — el format que espera el backend
 * (docs/contrato-api.md §2) no canvia, `value`/`onChange` sempre viatgen
 * en punt.
 */
type DecimalInputProps = {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /** Opcional: para formatear/redondear recién al perder el foco, nunca en cada tecla (ver Comandes, Pes demanat). */
  onBlur?: () => void;
  error?: string;
  disabled?: boolean;
  className?: string;
};

const DEFAULT_CLASSNAME =
  'w-full rounded-md border px-3 py-2 text-sm text-gray-900 focus:outline-none border-gray-300 focus:border-brand disabled:bg-gray-50 disabled:text-gray-400';

export const DecimalInput = forwardRef<HTMLInputElement, DecimalInputProps>(function DecimalInput(
  { label, value, onChange, onBlur, error, disabled, className },
  ref,
) {
  const input = (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      value={value.replace('.', ',')}
      onChange={(event) => onChange(event.target.value.replace(',', '.'))}
      onBlur={onBlur}
      disabled={disabled}
      className={
        className ?? `${DEFAULT_CLASSNAME} ${error ? 'border-red-400 focus:border-red-500' : ''}`
      }
    />
  );

  if (!label) {
    return (
      <>
        {input}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </>
    );
  }

  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-gray-900">{label}</span>
      {input}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </label>
  );
});
