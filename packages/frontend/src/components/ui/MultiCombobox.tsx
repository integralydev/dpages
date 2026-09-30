'use client';

import { X } from 'lucide-react';
import { useMemo } from 'react';
import { AsyncCombobox, type ComboboxOption } from './AsyncCombobox';

/**
 * Selecció múltiple sobre AsyncCombobox (petició del client, 29/09/2026:
 * filtrar el Panell Obrador per més d'un producte alhora). El cercador és
 * el de sempre, però en triar una opció s'afegeix com a etiqueta a sota i
 * el camp queda buit per afegir-ne una altra. Cada etiqueta es treu amb la
 * seva X; les ja triades no tornen a sortir als resultats.
 *
 * Mateixes classes d'ample que AsyncCombobox perquè dins d'un FilterBar es
 * reparteixi l'espai igual que els seus veïns. Les etiquetes queden fora
 * del <label> del cercador: un <button> dins d'un <label> li robaria el
 * focus.
 */
export function MultiCombobox({
  label,
  selected,
  onChange,
  loadOptions,
  debounceMs,
  placeholder,
  addMorePlaceholder,
}: {
  label?: string;
  selected: ComboboxOption[];
  onChange: (options: ComboboxOption[]) => void;
  loadOptions: (query: string) => Promise<ComboboxOption[]>;
  debounceMs?: number;
  placeholder?: string;
  /** Placeholder quan ja n'hi ha alguna de triada (per defecte, `placeholder`). */
  addMorePlaceholder?: string;
}) {
  const selectedIds = useMemo(() => new Set(selected.map((option) => option.id)), [selected]);

  const loadUnselectedOptions = useMemo(
    () => async (query: string) =>
      (await loadOptions(query)).filter((option) => !selectedIds.has(option.id)),
    [loadOptions, selectedIds],
  );

  function add(option: ComboboxOption | null) {
    if (option && !selectedIds.has(option.id)) onChange([...selected, option]);
  }

  function remove(id: number) {
    onChange(selected.filter((option) => option.id !== id));
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[110px] sm:flex-1">
      <AsyncCombobox
        label={label}
        value={null}
        displayValue=""
        placeholder={selected.length > 0 ? (addMorePlaceholder ?? placeholder) : placeholder}
        debounceMs={debounceMs}
        loadOptions={loadUnselectedOptions}
        onChange={add}
        clearable={false}
      />
      {selected.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label={label ? `${label}: seleccionats` : undefined}
        >
          {selected.map((option) => (
            <li
              key={option.id}
              className="flex max-w-full items-center gap-1 rounded-full border border-brand-light bg-brand-tint py-1 pr-1 pl-2.5 text-xs font-medium text-gray-900"
            >
              <span className="truncate" title={option.label}>
                {option.label}
              </span>
              <button
                type="button"
                onClick={() => remove(option.id)}
                aria-label={`Treure ${option.label}`}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-brand-light"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
