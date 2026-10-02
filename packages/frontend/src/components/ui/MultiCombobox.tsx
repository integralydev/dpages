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
 * Sense res triat, mateixes classes d'ample que AsyncCombobox perquè dins
 * d'un FilterBar es reparteixi l'espai igual que els seus veïns. Amb alguna
 * etiqueta (tasca 19, 01/10/2026): el filtre passa a ocupar tota la fila
 * del FilterBar, amb el cercador d'ample fix a l'esquerra i les etiquetes
 * una al costat de l'altra a la dreta — abans, en un camp estret, cada
 * etiqueta ocupava una fila i 6 valors feien una columna molt alta. Les
 * etiquetes queden fora del <label> del cercador: un <button> dins d'un
 * <label> li robaria el focus.
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

  const ambSeleccio = selected.length > 0;

  return (
    <div
      className={
        ambSeleccio
          ? 'flex w-full flex-col gap-2 sm:basis-full sm:flex-row sm:items-end sm:gap-3'
          : 'flex w-full flex-col gap-2 sm:w-auto sm:min-w-[110px] sm:flex-1'
      }
    >
      <div className={ambSeleccio ? 'w-full sm:w-64 sm:shrink-0' : 'contents'}>
        <AsyncCombobox
          label={label}
          value={null}
          displayValue=""
          placeholder={ambSeleccio ? (addMorePlaceholder ?? placeholder) : placeholder}
          debounceMs={debounceMs}
          loadOptions={loadUnselectedOptions}
          onChange={add}
          clearable={false}
        />
      </div>
      {ambSeleccio && (
        <ul
          className="flex min-w-0 flex-1 flex-wrap gap-1.5 sm:pb-1.5"
          aria-label={label ? `${label}: seleccionats` : undefined}
        >
          {selected.map((option) => (
            <li
              key={option.id}
              className="flex max-w-full items-center gap-1 rounded-full border border-brand-light bg-brand-tint py-1 pr-1 pl-2.5 text-xs font-medium text-gray-900 sm:max-w-[16rem]"
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
