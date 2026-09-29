'use client';

import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDropdownScrollArrows } from './useDropdownScrollArrows';
import { DROPDOWN_PANEL_Z_INDEX, useDropdownPosition } from './useDropdownPosition';

type SimpleDropdownBaseProps = {
  label?: string;
  placeholder?: string;
};

type SimpleDropdownStringProps = SimpleDropdownBaseProps & {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  /**
   * Prepèn aquesta opció al principi del panell — mateixa convenció de
   * "Tots"/"Totes" que YA feien servir tots els filtres abans d'aquest prop
   * (`options={[ALL, ...items]}`), ara sense haver-ho de repetir a cada
   * pantalla. `onChange` la rep exactament igual que qualsevol altra opció
   * (string pla) — MAI `null`/`undefined`: confirmat contra 3 consumidors
   * reals (`NO_CATEGORY` a ProductForm.tsx, `ALL_CATEGORIES` a
   * pig-yields/page.tsx, `PLACEHOLDER` a PigYieldFormModal.tsx) que cap
   * d'ells tradueix mai el sentinel a `null` — el guarden com a string i el
   * comparen amb `===`/`!==`; la conversió a `null` (si en fa falta alguna)
   * la fa la pròpia pantalla en construir el body de l'API, no aquest
   * component. Canviar-ho a `null` seria trencar aquesta convenció ja
   * establerta a tot arreu, no seguir-la.
   */
  allLabel?: string;
  booleanLabels?: undefined;
};

type SimpleDropdownBooleanProps = SimpleDropdownBaseProps & {
  /**
   * Mode booleà: només 2 opcions, `value`/`onChange` treballen amb
   * `boolean` en comptes de `string` — evita que cada pantalla repeteixi la
   * mateixa conversió manual. Confirmat contra 2 consumidors reals
   * (`CategoryFormModal` "Elaborat Porc", `UserFormModal` "Estat"): als dos
   * llocs `value` ja és un `boolean` de veritat (`useState<boolean>`), i la
   * conversió a "Sí"/"No" o "Actiu"/"Inactiu" ja la feien elles soles al
   * JSX (`value={elaboratPorc ? "Sí" : "No"}` /
   * `onChange={(v) => setElaboratPorc(v === "Sí")}`) — aquest mode mou
   * aquesta conversió acá dins, `value`/`onChange` del consumidor passen a
   * ser directament el boolean real.
   */
  booleanLabels: { yes: string; no: string };
  value: boolean;
  onChange: (value: boolean) => void;
  options?: undefined;
  allLabel?: undefined;
};

type SimpleDropdownProps = SimpleDropdownStringProps | SimpleDropdownBooleanProps;

/**
 * Alternativa al <select> nativo per a llistes curtes i fixes (sense xarxa,
 * sense debounce) — el panell d'opcions és un <div> propi, no el popup
 * natiu del navegador, així que el seu ample el controlem del tot amb CSS
 * nostra. Motiu real: el <select> nativo de Tarifa (17 opcions, noms fins a
 * 34 caràcters com "WEB, COOPES, PARTIC, RUSC (Paquet)") es desbordava en
 * TOTS els dispositius (desktop inclòs) — el navegador dimensiona el seu
 * popup pel `<option>` més ample, i això no és estilable via CSS.
 *
 * A diferència d'AsyncCombobox (buscador amb debounce, per a llistes que
 * vénen de la xarxa): acá no hi ha camp de text ni filtrat, és un botó que
 * obre un panell amb TOTES les opcions visibles d'una — mateix gest que un
 * <select>, però amb un panell que és nostre.
 *
 * El panell es renderitza via portal a `document.body`, amb `position:
 * fixed` calculat des del botó real (getBoundingClientRect) — NO
 * `position: absolute` dins del propi contenidor. Motiu real trobat en
 * ús: quan aquest component viu dins d'un Modal (cas de Tarifa a
 * ClientFormModal), el body del Modal és `overflow-y-auto` — un
 * descendent `absolute` que s'estén més enllà del contingut normal SÍ
 * compta per al "scrollable overflow" d'aquest ancestor (part de l'espec
 * de CSS, no un bug de Tailwind), encara que no mogui cap altre camp de
 * lloc. Resultat real: obrir el desplegable disparava el scroll intern
 * del modal sencer i el panell quedava fora de la zona visible fins que
 * l'usuari scrollejava per casualitat. Un portal amb `fixed` escapa per
 * complet d'aquest càlcul (el seu containing block és el viewport, no cap
 * ancestor amb overflow). El mateix patró (portal + col·lisió amb el
 * viewport) es va fer servir després a AsyncCombobox — ver
 * useDropdownPosition.ts, d'on ve el càlcul compartit entre tots dos.
 */
export function SimpleDropdown(props: SimpleDropdownProps) {
  const { label, placeholder = 'Selecciona...' } = props;
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  const panelPosition = useDropdownPosition(containerRef, isOpen);

  // Normalitza els 2 modes (string amb `allLabel` opcional, o booleà) a un
  // sol parell {options, displayValue} de strings — la resta del component
  // (renderitzat, checkmark, comparació) no necessita saber en quin mode
  // està.
  const options = props.booleanLabels
    ? [props.booleanLabels.yes, props.booleanLabels.no]
    : props.allLabel !== undefined
      ? [props.allLabel, ...props.options]
      : props.options;
  const displayValue = props.booleanLabels
    ? props.value
      ? props.booleanLabels.yes
      : props.booleanLabels.no
    : props.value;

  const { canScrollUp, canScrollDown, startAutoScroll, stopAutoScroll } = useDropdownScrollArrows(
    panelEl,
    isOpen,
    options.length,
  );

  useEffect(() => {
    if (!isOpen) return;

    // El panell viu al portal (document.body), fora de l'arbre de
    // containerRef — cal comprovar tots dos com a "dins", si no, clicar
    // una opció es llegiria com a "click fora" i tancaria el panell abans
    // que l'onClick de l'opció arribi a disparar-se.
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      const insideButton = containerRef.current?.contains(target) ?? false;
      const insidePanel = portalRef.current?.contains(target) ?? false;
      if (!insideButton && !insidePanel) setIsOpen(false);
    }

    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  function selectOption(option: string) {
    if (props.booleanLabels) {
      props.onChange(option === props.booleanLabels.yes);
    } else {
      props.onChange(option);
    }
    setIsOpen(false);
  }

  return (
    // Mateixes classes d'ample que la resta de camps de FilterBar
    // (SelectFilter, SearchInput, DateInput, DateRangeInput: `w-full
    // sm:min-w-[Npx] sm:w-auto sm:flex-1`) — abans faltaven acá i a
    // AsyncCombobox, així que dins d'un FilterBar (office/page.tsx,
    // client-tariffs/page.tsx) aquests dos camps no s'apilaven a ample
    // complet en mobile ni es repartien l'espai igual que els seus veïns en
    // desktop. Inofensiu fora d'un FilterBar (ClientFormModal, OrderForm):
    // `sm:flex-1`/`sm:w-auto` només fan res dins d'un contenidor flex, i
    // `min-w-[110px]` és menor que qualsevol columna real de grid o modal.
    <label className="flex w-full flex-col gap-1.5 text-sm sm:w-auto sm:min-w-[110px] sm:flex-1">
      {label && <span className="font-medium text-gray-900">{label}</span>}
      <div ref={containerRef}>
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className={`flex w-full items-center justify-between gap-2 rounded-md border bg-white px-3 py-2 text-left text-sm text-gray-900 focus:outline-none ${
            // Lligat a `isOpen` (no a :focus natiu): un click de ratolí no
            // sempre deixa el botó amb focus visible a tots els navegadors
            // (Safari en particular) — depenent del pseudo-classe :focus
            // deixaria el cas més comú (click) sense cap senyal. Mateix
            // gray-400 que ja fa servir el focus de TextField/SelectFilter,
            // no un color nou.
            isOpen ? 'border-brand' : 'border-gray-300 focus:border-brand'
          }`}
        >
          {/* truncate: el botó tancat és d'una sola línia — el text llarg
              es talla amb "..." acá, a diferència de les opcions del
              panell (de sota), que s'envolten senceres per no amagar cap
              nom de tarifa real. min-w-0 és necessari perquè `truncate`
              funcioni dins d'un contenidor flex — sense això, un fill flex
              no es redueix per sota de l'ample del seu contingut i el text
              llarg faria créixer el botó en comptes de tallar-se. */}
          <span className="min-w-0 truncate">{displayValue || placeholder}</span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {isOpen &&
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
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => selectOption(option)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                    option === displayValue
                      ? 'bg-gray-50 font-medium text-gray-900'
                      : 'text-gray-900'
                  }`}
                >
                  <span className="min-w-0 break-words whitespace-normal">{option}</span>
                  {option === displayValue && <Check className="h-4 w-4 shrink-0 text-gray-900" />}
                </button>
              ))}
            </div>

            {/* Fletxes d'auto-scroll: mateix patró que l'indicador de scroll
                horitzontal de Llistat de Tarifes (degradat + xip fosc amb
                fletxa) — degradat pointer-events-none perquè no bloquegi
                clics a les opcions de sota, xip pointer-events-auto perquè
                sí respongui al hover. Continu mentre el cursor hi és a
                sobre, es para en sortir o en arribar al topall. */}
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
