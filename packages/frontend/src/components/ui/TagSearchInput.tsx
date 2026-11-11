'use client';

import { Search, X } from 'lucide-react';
import type { ClipboardEvent, KeyboardEvent } from 'react';

/** Separadors que converteixen el text escrit en etiqueta (a més d'Enter). */
const SEPARADORS = /[,;]/;

/**
 * Cercador de text lliure amb etiquetes (tasca 52, Ari): el text que
 * s'escriu filtra a l'instant, com un SearchInput; amb Enter, coma o punt i
 * coma queda fixat com a etiqueta i el camp es buida per escriure'n un
 * altre. Enganxar "BOTT, SATXP" crea les dues etiquetes. Retrocés amb el
 * camp buit treu l'última etiqueta. Qui l'usa combina `values` + `draft`.
 *
 * Mateixa disposició que MultiCombobox: sense etiquetes, ample de veí dins
 * del FilterBar; amb etiquetes, ocupa tota la fila amb el camp d'ample fix
 * a l'esquerra i les etiquetes a la dreta (fora del <label>, perquè un
 * <button> dins d'un <label> li robaria el focus).
 */
export function TagSearchInput({
  label,
  placeholder,
  addMorePlaceholder,
  values,
  onValuesChange,
  draft,
  onDraftChange,
}: {
  label: string;
  placeholder?: string;
  /** Placeholder quan ja hi ha alguna etiqueta (per defecte, `placeholder`). */
  addMorePlaceholder?: string;
  values: string[];
  onValuesChange: (values: string[]) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
}) {
  // Afegeix els textos no buits que encara no hi són (sense distingir
  // majúscules) i buida el camp.
  function afegir(textos: string[]) {
    const nous = [...values];
    for (const text of textos.map((item) => item.trim()).filter(Boolean)) {
      if (!nous.some((existent) => existent.toLowerCase() === text.toLowerCase())) {
        nous.push(text);
      }
    }
    if (nous.length !== values.length) onValuesChange(nous);
    onDraftChange('');
  }

  function treure(index: number) {
    onValuesChange(values.filter((_, actual) => actual !== index));
  }

  function canviarText(text: string) {
    // Escriure una coma o un punt i coma fixa el que hi ha abans.
    if (SEPARADORS.test(text)) {
      const parts = text.split(SEPARADORS);
      const pendent = parts.pop() ?? '';
      afegir(parts);
      onDraftChange(pendent.trimStart());
    } else {
      onDraftChange(text);
    }
  }

  function teclaPremuda(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      afegir([draft]);
    } else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      treure(values.length - 1);
    }
  }

  function enganxar(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text');
    if (!SEPARADORS.test(text)) return;
    event.preventDefault();
    afegir((draft + text).split(SEPARADORS));
  }

  const ambEtiquetes = values.length > 0;

  return (
    <div
      className={
        ambEtiquetes
          ? 'flex w-full flex-col gap-2 sm:basis-full sm:flex-row sm:items-end sm:gap-3'
          : 'flex w-full flex-col gap-2 sm:w-auto sm:min-w-[130px] sm:flex-1'
      }
    >
      <label
        className={`flex flex-col gap-1.5 text-sm ${ambEtiquetes ? 'w-full sm:w-64 sm:shrink-0' : 'w-full'}`}
      >
        <span className="font-medium text-gray-900">{label}</span>
        <span className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder={ambEtiquetes ? (addMorePlaceholder ?? placeholder) : placeholder}
            value={draft}
            onChange={(event) => canviarText(event.target.value)}
            onKeyDown={teclaPremuda}
            onPaste={enganxar}
            className="w-full rounded-md border border-gray-300 py-2 pr-3 pl-9 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand focus:outline-none"
          />
        </span>
      </label>
      {ambEtiquetes && (
        <ul
          className="flex min-w-0 flex-1 flex-wrap gap-1.5 sm:pb-1.5"
          aria-label={`${label}: cerques actives`}
        >
          {values.map((value, index) => (
            <li
              key={value}
              className="flex max-w-full items-center gap-1 rounded-full border border-brand-light bg-brand-tint py-1 pr-1 pl-2.5 text-xs font-medium text-gray-900 sm:max-w-[16rem]"
            >
              <span className="truncate" title={`Comença per "${value}"`}>
                {value}…
              </span>
              <button
                type="button"
                onClick={() => treure(index)}
                aria-label={`Treure ${value}`}
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
