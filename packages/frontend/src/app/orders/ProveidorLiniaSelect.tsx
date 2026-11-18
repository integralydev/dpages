'use client';

import type { ProveidorApi, ReferenciaApi } from '@/lib/api';

const SENSE = '';

/**
 * Punt 55 (18/11/2026): proveïdor d'una línia de comanda, opcional. En
 * triar l'article ja s'hi posa el seu proveïdor preferit (ver applyProduct
 * a OrderForm); aquí es pot canviar o treure. Va sota el producte, a la
 * taula i a la targeta, per no afegir una columna més.
 */
export function ProveidorLiniaSelect({
  value,
  proveidors,
  disabled,
  onChange,
}: {
  value: ReferenciaApi | null;
  proveidors: ProveidorApi[];
  disabled: boolean;
  onChange: (proveidor: ReferenciaApi | null) => void;
}) {
  // Si el proveïdor de la línia ja no és a la llista (p. ex. encara no ha
  // carregat), es mostra igualment perquè el select no el perdi.
  const opcions =
    value && !proveidors.some((proveidor) => proveidor.id === value.id)
      ? [value, ...proveidors]
      : proveidors;

  return (
    <label className="mt-1.5 flex items-center gap-2 text-xs text-gray-500">
      <span className="shrink-0">Proveïdor</span>
      <select
        value={value ? String(value.id) : SENSE}
        disabled={disabled}
        onChange={(event) => {
          const id = Number(event.target.value);
          const triat = opcions.find((proveidor) => proveidor.id === id);
          onChange(triat ? { id: triat.id, nom: triat.nom } : null);
        }}
        className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
      >
        <option value={SENSE}>Sense proveïdor</option>
        {opcions.map((proveidor) => (
          <option key={proveidor.id} value={String(proveidor.id)}>
            {proveidor.nom}
          </option>
        ))}
      </select>
    </label>
  );
}
