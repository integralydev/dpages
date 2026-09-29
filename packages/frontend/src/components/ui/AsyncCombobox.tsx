'use client';

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDropdownScrollArrows } from './useDropdownScrollArrows';
import { DROPDOWN_PANEL_Z_INDEX, useDropdownPosition } from './useDropdownPosition';

export type ComboboxOption = { id: number; label: string };

/**
 * Combobox con búsqueda: input de texto que dispara `loadOptions(query)`
 * con debounce y muestra un dropdown con los resultados reales — nunca
 * carga un listado completo de una, a diferencia de un <select> nativo.
 *
 * Sirve para dos modos según qué le pases a `loadOptions`, sin que el
 * componente sepa la diferencia:
 * - Servidor (Client en Oficina/Comandes): `loadOptions` pega a
 *   `GET .../?cerca=` — necesita debounce real (300ms) para no saturar
 *   la red en cada tecla.
 * - Local (Producte en Comandes): `loadOptions` filtra en memoria un
 *   array ya cargado y envuelve el resultado en `Promise.resolve(...)`
 *   — no pega a la red, por eso el caller pasa `debounceMs={0}`.
 *
 * `onChange` entrega la opción completa (`{id, label}`), no sólo el id:
 * así ningún caller necesita guardar un array completo aparte sólo para
 * poder mostrar el texto de lo ya seleccionado (ver Panell Oficina, que
 * ya no carga los 200 clients de golpe una vez que dejó de necesitarlos
 * para poblar el <select>).
 *
 * `displayValue` es lo que se muestra cuando el campo no está en edición
 * activa. `clearable` (default true) agrega una X para volver a `null`
 * — el <select> nativo que reemplaza siempre tenía una opción "Tots"/
 * "Selecciona..." como escape; sin esto sería una regresión real.
 *
 * El panel de resultados se renderiza vía portal a `document.body`, con
 * `position: fixed` calculado desde el input real (useDropdownPosition,
 * compartido con SimpleDropdown) en vez de `position: absolute` dentro del
 * propio contenedor — mismo motivo real que en SimpleDropdown: si este
 * combobox llega a usarse dentro de un Modal (body `overflow-y-auto`), un
 * descendiente `absolute` que se extiende más allá del contenido normal
 * cuenta para el "scrollable overflow" de ese ancestro y dispara el scroll
 * interno del modal entero al abrir el dropdown. El portal con `fixed`
 * escapa por completo de ese cálculo. Ver useDropdownPosition.ts para el
 * detalle de la detección de colisión con el viewport (abre hacia arriba si
 * no entra hacia abajo).
 */
export function AsyncCombobox({
  label,
  value,
  displayValue,
  onChange,
  loadOptions,
  debounceMs = 300,
  placeholder,
  disabled,
  clearable = true,
}: {
  label?: string;
  value: number | null;
  displayValue: string;
  onChange: (option: ComboboxOption | null) => void;
  loadOptions: (query: string) => Promise<ComboboxOption[]>;
  debounceMs?: number;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [options, setOptions] = useState<ComboboxOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // El panell de resultats viu al portal (document.body), fora de l'arbre
  // de containerRef — igual que a SimpleDropdown, cal comprovar tots dos
  // com a "dins" al click-outside.
  const portalRef = useRef<HTMLDivElement>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  const showDropdown = isEditing && query.trim() !== '';
  const panelPosition = useDropdownPosition(containerRef, showDropdown);
  const { canScrollUp, canScrollDown, startAutoScroll, stopAutoScroll } = useDropdownScrollArrows(
    panelEl,
    showDropdown,
    options.length,
  );
  // Descarta resultados de una búsqueda vieja que llega tarde (network
  // fuera de orden) — sólo el request más reciente puede escribir `options`.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!isEditing) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      const insideInput = containerRef.current?.contains(target) ?? false;
      const insidePanel = portalRef.current?.contains(target) ?? false;
      if (!insideInput && !insidePanel) {
        setIsEditing(false);
        setQuery('');
        setOptions([]);
      }
    }

    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [isEditing]);

  // Arranca vacío, sin dropdown, hasta que el usuario escribe — mismo
  // criterio para los 3 usos, sin precargar nada aunque loadOptions sea
  // local y "gratis" de llamar.
  useEffect(() => {
    if (!isEditing || query.trim() === '') {
      // Sense text encara no hi ha res a cercar (ver comentari de dalt) —
      // cal netejar un resultat d'una cerca anterior, no és un valor
      // derivable durant el render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOptions([]);
      setIsLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setIsLoading(true);

    const timeoutId = setTimeout(() => {
      loadOptions(query.trim())
        .then((results) => {
          if (requestIdRef.current === requestId) setOptions(results);
        })
        .catch(() => {
          if (requestIdRef.current === requestId) setOptions([]);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setIsLoading(false);
        });
    }, debounceMs);

    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isEditing, debounceMs]);

  function selectOption(option: ComboboxOption) {
    onChange(option);
    setIsEditing(false);
    setQuery('');
    setOptions([]);
  }

  function clearSelection() {
    onChange(null);
    setQuery('');
    setIsEditing(false);
  }

  const showClearButton = clearable && !disabled && !isEditing && value !== null;

  return (
    // Mateixes classes d'ample que la resta de camps de FilterBar
    // (SelectFilter, SearchInput, DateInput, DateRangeInput, i ara
    // SimpleDropdown): abans faltaven acá, així que dins d'un FilterBar
    // (office/page.tsx, packaging/page.tsx, workshop/page.tsx,
    // production/page.tsx) el camp Client/Producte no s'apilava a ample
    // complet en mobile ni es repartia l'espai igual que els seus veïns en
    // desktop. Inofensiu fora d'un FilterBar (OrderForm.tsx, un grid):
    // `sm:flex-1`/`sm:w-auto` només fan res dins d'un contenidor flex.
    <label className="flex w-full flex-col gap-1.5 text-sm sm:w-auto sm:min-w-[110px] sm:flex-1">
      {label && <span className="font-medium text-gray-900">{label}</span>}
      <div ref={containerRef} className="relative">
        <input
          type="text"
          value={isEditing ? query : displayValue}
          disabled={disabled}
          placeholder={placeholder}
          onFocus={() => setIsEditing(true)}
          onChange={(event) => setQuery(event.target.value)}
          className={`w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400 ${
            showClearButton ? 'pr-8' : ''
          }`}
        />
        {showClearButton && (
          <button
            type="button"
            onClick={clearSelection}
            aria-label="Netejar selecció"
            className="absolute top-1/2 right-2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {showDropdown &&
        panelPosition &&
        createPortal(
          <div
            ref={portalRef}
            className="fixed"
            style={{
              left: panelPosition.left,
              width: panelPosition.width,
              zIndex: DROPDOWN_PANEL_Z_INDEX,
              ...(panelPosition.direction === 'down'
                ? { top: panelPosition.top }
                : { bottom: panelPosition.bottom }),
            }}
          >
            <div
              ref={setPanelEl}
              className="dropdown-panel-scroll overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg"
              style={{ maxHeight: panelPosition.maxHeight }}
            >
              {isLoading && <p className="px-3 py-2 text-sm text-gray-500">Cercant...</p>}
              {!isLoading && options.length === 0 && (
                <p className="px-3 py-2 text-sm text-gray-500">Sense resultats.</p>
              )}
              {!isLoading &&
                options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => selectOption(option)}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                      option.id === value ? 'bg-gray-50 font-medium text-gray-900' : 'text-gray-900'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
            </div>

            {/* Fletxes d'auto-scroll: mateix patró que SimpleDropdown (extret a
                useDropdownScrollArrows) — única senyal de "hi ha més
                resultats" ara que la barra de scroll nativa està amagada. */}
            {canScrollUp && (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center rounded-t-md bg-gradient-to-b from-white via-white/90 to-transparent pt-1 pb-1.5">
                <button
                  type="button"
                  aria-label="Desplaça amunt"
                  onMouseEnter={() => startAutoScroll(-1)}
                  onMouseLeave={stopAutoScroll}
                  className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full bg-gray-900/85 text-white shadow-sm hover:bg-gray-900"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
              </div>
            )}
            {canScrollDown && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center rounded-b-md bg-gradient-to-t from-white via-white/90 to-transparent pt-1.5 pb-1">
                <button
                  type="button"
                  aria-label="Desplaça avall"
                  onMouseEnter={() => startAutoScroll(1)}
                  onMouseLeave={stopAutoScroll}
                  className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full bg-gray-900/85 text-white shadow-sm hover:bg-gray-900"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </label>
  );
}
