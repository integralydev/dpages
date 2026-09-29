'use client';

import { Plus } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { AsyncCombobox, type ComboboxOption } from '@/components/ui/AsyncCombobox';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataCard, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { DecimalInput } from '@/components/ui/DecimalInput';
import { IconButton } from '@/components/ui/IconButton';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { TextField } from '@/components/ui/TextField';
import type { OrderFormValues, OrderLineChanges } from '@/hooks/useOrders';
import {
  api,
  type ClientApi,
  type ComandaDetallApi,
  type ComandaLiniaApi,
  type FilaMatriuTarifesApi,
  type LiniaCreacioApi,
  type LiniaEdicioApi,
  type OrigenComandaApi,
  type ProducteApi,
  type RespostaPaginada,
  type TarifaResumApi,
  type TransportistaApi,
} from '@/lib/api';
import { ESTAT_LABELS } from '@/lib/comandaEstat';
import { formatDecimal, parseDecimalInput } from '@/lib/decimals';
import { calculateOrderedWeightKg } from '@/lib/orderCalculations';
import { MAX_LOCAL_COMBOBOX_RESULTS, matchesProductQuery } from '@/lib/productSearch';

const NO_CLIENT = 'Selecciona client...';
const NO_TARIFF = 'Sense tarifa';
const NO_CARRIER = 'Selecciona transportista...';
const NO_PRODUCT = 'Selecciona producte...';
const NO_ORIGIN = 'Selecciona origen...';

// Avís preventiu de preu (ver resolvePriceRisk) — quan hi ha tarifa vigent i
// cal confirmar-ho contra GET /tarifes/matriu, no es dispara una crida per
// cada tecla en triar producte/tarifa; s'espera aquest marge des de l'últim
// canvi rellevant.
const TARIFF_COVERAGE_DEBOUNCE_MS = 300;

// Un pedido puede cargarse/reasignarse manualmente a cualquiera de estos 4
// canales (whatsapp/telefon/correu/woocommerce, ver origen_comanda) — tanto
// al crear uno nuevo como al reasignar el origen de uno existente. Sólo
// "manual" (valor histórico) sigue sin poder elegirse a mano — por eso el
// filtro es explícito por código, no "todo lo que devuelva
// GET /origens-comanda".
const CODIS_ORIGEN_ELEGIBLES = ['whatsapp', 'telefon', 'correu', 'woocommerce'];

// amb_incidencia queda FORA d'aquesta llista a propòsit (decisió de UX
// confirmada): el selector de capçalera només serveix per triar
// lliurement entre els 3 estats que no exigeixen motiu. L'única via cap a
// amb_incidencia és el botó "Marcar com a incidència" (pantalla pare), que
// sí demana `detall`. Si la comanda ja estava amb_incidencia en carregar
// el formulari, es reafegeix dinàmicament a les opcions (ver estatOptions
// més avall) només perquè el <select> mostri l'estat real — mai perquè es
// pugui triar cap a ella des d'acá.
// cancellada (petició d'Ari, 29/09/2026) sí és triable aquí: no demana
// motiu, i treu la comanda de tots els panells.
const ESTAT_OPTIONS_SELECCIONABLES: string[] = ['oberta', 'en_proces', 'tancada', 'cancellada'];

function clientLabel(client: ClientApi) {
  return `${client.codi ?? client.id} · ${client.nom ?? ''}`;
}

function tariffLabel(tariff: TarifaResumApi) {
  return `${tariff.codi ?? tariff.id} · ${tariff.nom}`;
}

function carrierLabel(carrier: TransportistaApi) {
  return `${carrier.codi ?? carrier.id} · ${carrier.nom}`;
}

function productLabel(product: ProducteApi) {
  return `${product.codi ?? product.id} · ${product.descripcio}`;
}

// GET /clients?cerca= es substring case-insensitive real (confirmat amb
// curl real) — a diferència de GET /productes?cerca=, que fa coincidència
// EXACTA a propòsit (regla 3.1: "lomo" no ha de portar "cabeza de lomo").
// Per això Client usa mode servidor (AsyncCombobox pegant a l'API) i
// Producte usa mode local (filtrant l'array `products` ja carregat).
async function loadClientOptions(query: string): Promise<ComboboxOption[]> {
  const resposta = await api.get<RespostaPaginada<ClientApi>>('/clients', {
    cerca: query,
    mida: 8,
  });
  return resposta.dades.map((client) => ({ id: client.id, label: clientLabel(client) }));
}

function loadLocalProductOptions(products: ProducteApi[]) {
  return (query: string): Promise<ComboboxOption[]> =>
    Promise.resolve(
      products
        .filter((product) => matchesProductQuery(product, query))
        .slice(0, MAX_LOCAL_COMBOBOX_RESULTS)
        .map((product) => ({ id: product.id, label: productLabel(product) })),
    );
}

type LineDraft = ComandaLiniaApi;

let tempLineId = -1;

function createEmptyLine(ordinal: number): LineDraft {
  return {
    id: tempLineId--,
    ordinal,
    producte: null,
    categoria: null,
    format: null,
    envasat: null,
    unitatsDemanades: '0',
    // "0" pla, no "0.000": mateix criteri que unitatsDemanades — evita que
    // el cursor caigui enmig dels decimals en fer clic. Només afecta el
    // default d'una línia nova "a mida" (kgEditable=true) — un producte amb
    // pes de fitxa el
    // sobreescriu de seguida amb el pes real calculat (ver applyProduct).
    kgDemanats: '0',
    kgEditable: true,
    unitatsLliurades: '0',
    kgLliurats: '0.000',
    confirmatA: null,
    // El backend calcula preuUnitari/totalLinia al crear la línia
    // (resolverPreuLinia: cascada tarifa→preu base→incidència) — nunca se
    // precalculan acá, quedan en "0.00" hasta que la respuesta real del
    // backend los complete.
    preuUnitari: '0.00',
    totalLinia: '0.00',
    dataProduccio: null,
    obsProduccio: '',
    esborrat: false,
  };
}

/**
 * Línia nova → shape de POST /comandes (alta completa) i POST
 * /comandes/:comandaId/linies (afegir línia a una comanda ja creada) —
 * mateix `LiniaCreacioApi` als dos casos. `dataProduccio`: abans no
 * existia aquest camp al body de creació, així que el valor que l'usuari
 * carregava a la línia es perdia en silenci en comptes de guardar-se.
 */
function toLiniaCreacio(line: LineDraft): LiniaCreacioApi {
  return {
    producteId: line.producte!.id,
    // LineDraft.unitatsDemanades és string (NUMERIC(10,2) al GET), però el
    // body de POST/PATCH segueix esperant un JS number.
    unitatsDemanades: Number(line.unitatsDemanades),
    kgDemanats: line.kgEditable ? line.kgDemanats : undefined,
    // Issue #21 — LiniaCreacioApi.dataProduccio torna a admetre null: ja no
    // hi ha cap bloqueig de submit que en garanteixi la presència.
    dataProduccio: line.dataProduccio,
  };
}

/** Línia existent → shape de PATCH .../linies/:liniaId — mai inclou producteId ni preuUnitari. */
function toLiniaEdicio(line: LineDraft): LiniaEdicioApi {
  return {
    unitatsDemanades: Number(line.unitatsDemanades),
    kgDemanats: line.kgEditable ? line.kgDemanats : undefined,
    dataProduccio: line.dataProduccio,
    obsProduccio: line.obsProduccio || null,
  };
}

/**
 * Compara dues dates "YYYY-MM-DD" — buida a qualsevol banda mai viola res
 * (camps opcionals). ESTRICTE a propòsit (`>`, no `>=`): dates IGUALS
 * estan permeses — mateix criteri confirmat al backend
 * (`validarCoherenciaDatesComanda` a comandes.ts), que documenta
 * explícitament aquest cas límit com a resolt (no com un buit).
 */
function isDateAfter(a: string, b: string): boolean {
  return a !== '' && b !== '' && a > b;
}

/** `ComandaLiniaApi.dataProduccio` viatja amb hora ("...T00:00:00Z"); les dates de capçalera no — normalitza abans de comparar. */
function dateOnly(value: string | null): string {
  return value ? value.slice(0, 10) : '';
}

/** Únic default real dels 3 camps de data obligatoris (issue #16) — cap dels dos (dataComanda/dataLliurament) té default al backend, ver docblock de ComandaCreacioApi a @dpages/shared. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Regles 2/3/7 — validació de client per feedback immediat; el backend les
 * aplica també (POST /comandes, PATCH /comandes/:id i els dos endpoints de
 * línia) com a última paraula, per si aquest formulari deixa passar algun
 * cas (ver `extractComandaErrorMessage` a useOrders.ts).
 *
 * Fusió Data producció / Data comanda de capçalera (decisió de negoci,
 * confirmada per investigació: `dataProduccio` de capçalera no s'usa en
 * cap filtre/pantalla més que aquesta pròpia validació) — el
 * formulari ja no té cap input separat per a `dataProduccio` de capçalera,
 * es manda sempre idèntica a `dataComanda`. Això absorbeix l'antiga regla 1
 * ("dataLliurament no anterior a dataProduccio de capçalera"), que passa a
 * ser matemàticament idèntica a la regla 7 un cop `dataProduccio` de
 * capçalera = `dataComanda` — mantenir-la per separat només duplicaria el
 * mateix error sota dos camps.
 */
function validateHeaderDates(
  dataComanda: string,
  dataLliurament: string,
  dataExpedicio: string,
): { dataComanda?: string; dataExpedicio?: string } {
  const errors: { dataComanda?: string; dataExpedicio?: string } = {};
  // Regla 7 (issue #16, ja implementada al backend) — dataComanda no pot
  // ser posterior a dataLliurament.
  if (isDateAfter(dataComanda, dataLliurament)) {
    errors.dataComanda = 'Aquesta data no pot ser posterior a la Data de lliurament.';
  }
  // Regla 2 (comparava contra dataProduccio de capçalera, ara fusionada amb dataComanda).
  if (isDateAfter(dataComanda, dataExpedicio)) {
    errors.dataExpedicio = 'Aquesta data no pot ser anterior a la Data de comanda.';
  } else if (isDateAfter(dataExpedicio, dataLliurament)) {
    errors.dataExpedicio = 'Aquesta data no pot ser posterior a la Data de lliurament.';
  }
  return errors;
}

/**
 * Regles 4-6 — la data de producció d'una línia contra les dates de
 * capçalera ja vigents. Regla 4 comparava contra `dataProduccio` de
 * capçalera; ara fusionada amb `dataComanda` (ver `validateHeaderDates`).
 */
function validateLineDate(
  lineDataProduccio: string | null,
  headerDataComanda: string,
  headerDataLliurament: string,
  headerDataExpedicio: string,
): string | undefined {
  const lineDate = dateOnly(lineDataProduccio);
  if (lineDate === '') return undefined;
  if (isDateAfter(headerDataComanda, lineDate)) {
    return 'Aquesta data no pot ser anterior a la Data de comanda.';
  }
  if (isDateAfter(lineDate, headerDataLliurament)) {
    return 'Aquesta data no pot ser posterior a la Data de lliurament.';
  }
  if (isDateAfter(lineDate, headerDataExpedicio)) {
    return "Aquesta data no pot ser posterior a la Data d'expedició.";
  }
  return undefined;
}

function applyProduct(line: LineDraft, product: ProducteApi | undefined): LineDraft {
  if (!product) {
    return {
      ...line,
      producte: null,
      categoria: null,
      format: null,
      envasat: null,
      kgEditable: true,
    };
  }
  const orderedWeight = calculateOrderedWeightKg(Number(line.unitatsDemanades), product);
  return {
    ...line,
    producte: { id: product.id, codi: product.codi, descripcio: product.descripcio },
    categoria: product.categoria?.nom ?? null,
    format: product.format,
    envasat: product.envasat,
    kgEditable: product.pesKg === null,
    kgDemanats: orderedWeight.isCalculated ? orderedWeight.value.toFixed(3) : line.kgDemanats,
  };
}

/** null = encara no se sap (petició en curs o pendent de debounce). */
type TariffCoverageStatus = 'covered' | 'not-covered';

function tariffCoverageKey(tarifaId: number, producteId: number): string {
  return `${tarifaId}:${producteId}`;
}

/**
 * Avís preventiu (no bloquejant) del cas que es quedarà sense preu
 * resolt — mirall exacte de la cascada real de `resolverPreuLinia`
 * (comandes.ts): (1) preu de la tarifa vigent, (2) si no n'hi ha,
 * `producte.preuVenda`, (3) si tampoc, es registra la incidència però
 * la comanda es desa igualment (decisió de negoci confirmada — ja no
 * bloqueja ni canvia l'estat de la comanda).
 *
 * Dos casos:
 * - Sense tarifa (`tarifaId === null`): certesa local, no cal cap crida —
 *   si `preuVenda` també és null, els dos passos de la cascada fallen sí o
 *   sí (cas original).
 * - Amb tarifa vigent i `preuVenda === null` (l'únic altre cas on el pas 2
 *   no serveix de xarxa de seguretat): abans es callava perquè el
 *   frontend no tenia manera de saber si aquesta tarifa concreta cobreix
 *   el producte. Ara sí es pot saber, consultant GET /tarifes/matriu
 *   (mateixa font que Llistat de Tarifes) — `tariffCoverage` és la cache
 *   ja resolta per l'efecte de OrderForm, `isChecking: true` mentre
 *   encara no hi ha resposta (no s'afirma res mentrestant, ni true ni
 *   false).
 * - Si `preuVenda` NO és null, el pas 2 sempre és una xarxa de seguretat
 *   vàlida encara que la tarifa no cobreixi el producte — mai hi ha risc
 *   cert acá, per això no cal ni consultar la matriu.
 */
function resolvePriceRisk(
  line: LineDraft,
  tarifaId: number | null,
  products: ProducteApi[],
  tariffCoverage: Map<string, TariffCoverageStatus>,
): { risk: boolean; isChecking: boolean } {
  if (line.producte === null) return { risk: false, isChecking: false };
  const product = products.find((p) => p.id === line.producte!.id);
  if (!product) return { risk: false, isChecking: false };

  if (tarifaId === null) {
    return { risk: product.preuVenda === null, isChecking: false };
  }
  if (product.preuVenda !== null) return { risk: false, isChecking: false };

  const status = tariffCoverage.get(tariffCoverageKey(tarifaId, product.id));
  if (status === undefined) return { risk: false, isChecking: true };
  return { risk: status === 'not-covered', isChecking: false };
}

function LineFormCard({
  line,
  products,
  tarifaId,
  tariffCoverage,
  disabled,
  headerDates,
  onUpdate,
  onRemove,
}: {
  line: LineDraft;
  products: ProducteApi[];
  tarifaId: number | null;
  tariffCoverage: Map<string, TariffCoverageStatus>;
  disabled: boolean;
  headerDates: { dataComanda: string; dataLliurament: string; dataExpedicio: string };
  onUpdate: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
}) {
  const product = products.find((p) => p.id === line.producte?.id);
  const dateError = validateLineDate(
    line.dataProduccio,
    headerDates.dataComanda,
    headerDates.dataLliurament,
    headerDates.dataExpedicio,
  );
  const { risk: priceRisk } = resolvePriceRisk(line, tarifaId, products, tariffCoverage);
  // Línia ja existent (persistida, id>0): PATCH /comandes/:id/linies/:liniaId
  // no accepta producteId — no hi ha manera de comunicar un canvi de
  // producte al backend en una línia ja creada. Es desactiva el selector
  // perquè triar-ne un altre aquí no es guardaria mai en silenci.
  const productLocked = !disabled && line.id > 0;

  return (
    <DataCard>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <AsyncCombobox
            value={line.producte?.id ?? null}
            displayValue={line.producte ? productLabel(line.producte as ProducteApi) : ''}
            placeholder={NO_PRODUCT}
            disabled={disabled || productLocked}
            debounceMs={0}
            loadOptions={loadLocalProductOptions(products)}
            onChange={(option) => {
              const selected = option ? products.find((p) => p.id === option.id) : undefined;
              onUpdate(applyProduct({ ...line }, selected));
            }}
          />
          {priceRisk && (
            <p className="mt-1.5 text-xs text-amber-700">
              Aquest producte no té preu assignat. La comanda es desarà igualment — caldrà completar
              el preu més endavant.
            </p>
          )}
        </div>
        <IconButton
          variant="delete"
          label="Eliminar línia"
          onClick={onRemove}
          disabled={disabled}
          className="shrink-0"
        />
      </div>

      <div className="mt-3">
        <DataCardGrid>
          <DataCardField label="Categoria">{line.categoria ?? '—'}</DataCardField>
          <DataCardField label="Format">{line.format ?? '—'}</DataCardField>
          <DataCardField label="Envasat">{line.envasat ?? '—'}</DataCardField>
        </DataCardGrid>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-gray-500">Data producció</span>
          <input
            type="date"
            disabled={disabled}
            value={line.dataProduccio ? line.dataProduccio.slice(0, 10) : ''}
            onChange={(event) =>
              onUpdate({
                dataProduccio: event.target.value ? `${event.target.value}T00:00:00Z` : null,
              })
            }
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
          />
          {dateError && <span className="text-xs text-red-600">{dateError}</span>}
          {/* Issue #21 — indicador informatiu, no una incidència: dataProduccio
              ja no és obligatòria, però una línia ja existent (persistida)
              sense data assignada val la pena que es noti a primer cop d'ull,
              en comptes de confondre's amb un input buit qualsevol. Només per
              a línies ja existents (line.id > 0) — una línia nova encara no
              tocada no és "un problema", és l'estat inicial normal. */}
          {line.id > 0 && line.dataProduccio === null && (
            <Badge variant="neutral">Sense data assignada</Badge>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-gray-500">Unitats demanades</span>
          <DecimalInput
            disabled={disabled}
            value={line.unitatsDemanades}
            onChange={(value) => {
              const recalculated = calculateOrderedWeightKg(Number(value), product);
              onUpdate({
                unitatsDemanades: value,
                kgDemanats:
                  !line.kgEditable && recalculated.isCalculated
                    ? recalculated.value.toFixed(3)
                    : line.kgDemanats,
              });
            }}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-right text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
          />
        </label>
        {/* Unitats/pes lliurats: sólo lectura acá — únicamente el Panell
            Empaquetat los edita (PATCH .../linies/:liniaId/lliurament),
            nunca esta pantalla (regla de negocio confirmada). */}
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-gray-500">Unitats lliurades</span>
          <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-right text-gray-500">
            {formatDecimal(line.unitatsLliurades, 2)}
          </span>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-gray-500">Pes demanat (kg)</span>
          {/* kgEditable es el campo autoritativo del backend (contrato §4.5:
              "no lo deduzcas en el frontend") — no se deriva de si ya se
              pudo calcular el peso localmente, que depende de que el
              catálogo haya terminado de cargar. */}
          {!line.kgEditable ? (
            <input
              type="text"
              value={Number(line.kgDemanats).toFixed(3).replace('.', ',')}
              disabled
              className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-right text-sm text-gray-400"
            />
          ) : (
            <DecimalInput
              disabled={disabled}
              value={line.kgDemanats}
              onChange={(value) => onUpdate({ kgDemanats: value })}
              onBlur={() => onUpdate({ kgDemanats: parseDecimalInput(line.kgDemanats, 3) })}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-right text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
            />
          )}
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-gray-500">Pes lliurat (kg)</span>
          <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-right text-gray-500">
            {line.kgLliurats}
          </span>
        </div>
      </div>

      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="text-xs text-gray-500">Obs. producció</span>
        <textarea
          value={line.obsProduccio ?? ''}
          disabled={disabled}
          onChange={(event) => onUpdate({ obsProduccio: event.target.value })}
          rows={2}
          className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
        />
      </label>
    </DataCard>
  );
}

export type OrderFormHandle = {
  submit: () => void;
};

export const OrderForm = forwardRef<
  OrderFormHandle,
  {
    mode: 'create' | 'edit';
    initialData?: ComandaDetallApi;
    isFrozen?: boolean;
    clients: ClientApi[];
    tariffs: TarifaResumApi[];
    carriers: TransportistaApi[];
    products: ProducteApi[];
    origins: OrigenComandaApi[];
    onSave: (values: OrderFormValues, lineChanges: OrderLineChanges) => Promise<void>;
    onDeleteLine?: (liniaId: number) => Promise<void>;
    /**
     * Notifica al pare cada cop que canvia si hi ha dates en conflicte
     * (regles 1-6), perquè pugui deshabilitar el seu propi botó "Desar" —
     * segona capa independent del `return` anticipat dins `submit()`: no
     * depèn de cap timing de `useImperativeHandle`/ref, és un simple
     * booleà d'estat al pare que es recalcula amb cada render d'acá.
     */
    onDateErrorsChange?: (hasErrors: boolean) => void;
    /**
     * Notifica al pare cada cop que canvia si hi ha canvis sense desar
     * (issue #15) — mateix patró que `onDateErrorsChange`: el pare (viu a
     * NavigationGuardContext) necessita aquest booleà per bloquejar
     * beforeunload/navegació interna, però la font de veritat de "què s'ha
     * tocat" viu acá dins, no té sentit duplicar-la al pare.
     */
    onDirtyChange?: (isDirty: boolean) => void;
  }
>(function OrderForm(
  {
    mode,
    initialData,
    isFrozen = false,
    clients,
    tariffs,
    carriers,
    products,
    origins,
    onSave,
    onDeleteLine,
    onDateErrorsChange,
    onDirtyChange,
  },
  ref,
) {
  const [estat, setEstat] = useState<string>(initialData?.estat ?? 'oberta');
  // Creació: cap valor triat encara (null). Edició: arrenca amb l'origen
  // actual del pedido — pot ser "manual" (valor històric, no elegible per
  // triar, ver CODIS_ORIGEN_ELEGIBLES), que igualment s'ha de poder MOSTRAR
  // correctament fins que l'usuari el canviï a mà.
  const [origenCodi, setOrigenCodi] = useState<string | null>(
    mode === 'edit' ? (initialData?.origen ?? null) : null,
  );
  // Mateix patró que tariffTouched/poblacioTouched: `editOrder` (useOrders.ts)
  // només inclou `origen` al PATCH quan l'usuari l'ha triat de veritat —
  // reenviar per defecte l'origen actual d'un pedido en "manual" (l'únic
  // codi que segueix sense poder-se triar) el rebutjaria el backend (400),
  // encara que ningú volgués canviar-lo.
  const [origenTouched, setOrigenTouched] = useState(false);
  const [clientId, setClientId] = useState<number | null>(initialData?.client?.id ?? null);
  const [poblacioDesti, setPoblacioDesti] = useState(initialData?.poblacioDesti ?? '');
  const [tarifaId, setTarifaId] = useState<number | null>(initialData?.tarifa?.id ?? null);
  const [tariffTouched, setTariffTouched] = useState(false);
  // Mateix patró que tariffTouched: un cop l'usuari edita "Població de
  // destí" a mà, cap canvi de client posterior el torna a pisar en aquesta
  // sessió del formulari.
  const [poblacioTouched, setPoblacioTouched] = useState(false);
  const [transportistaId, setTransportistaId] = useState<number | null>(
    initialData?.transportista?.id ?? null,
  );
  // Issue #16 — nova, OBLIGATÒRIA (columna real comanda.dataComanda, NOT
  // NULL). `initialData?.dataComanda` sempre ve informada en mode edició
  // (el tipus ComandaDetallApi.dataComanda ja no és nullable) — el `?? today()`
  // només s'activa en mode creació.
  //
  // Fusió Data producció / Data comanda de capçalera (decisió de negoci) —
  // ja NO hi ha estat separat per a `dataProduccio` de capçalera: es manda
  // sempre idèntica a `dataComanda` en construir el
  // payload (ver useOrders.ts createOrder/editOrder), sense mostrar cap
  // input separat a l'usuari. El de cada LÍNIA (`line.dataProduccio`) és un
  // concepte real i distint que NO es toca.
  const [dataComanda, setDataComanda] = useState(initialData?.dataComanda?.slice(0, 10) ?? today());
  // Issue #16 — passa a OBLIGATÒRIA només en creació (POST /comandes la
  // rebutja buida); en edició segueix sent nullable de veritat a la base
  // (PATCH la deixa buidar).
  //
  // Sense default d'"avui" (correcció posterior): la migració 0019 i
  // docs/contrato-api.md atribuïen aquest default a una confirmació de
  // negoci que en realitat no es va donar per a aquest camp concret (la
  // documentació es corregeix per separat) — mateix criteri que ja
  // fan servir dataExpedicio i el dataProduccio de cada línia: obligatori,
  // sense cap valor precarregat, l'usuari sempre l'omple a mà.
  const [dataLliurament, setDataLliurament] = useState(
    initialData?.dataLliurament?.slice(0, 10) ?? '',
  );
  const [dataExpedicio, setDataExpedicio] = useState(
    initialData?.dataExpedicio?.slice(0, 10) ?? '',
  );
  const [bultos, setBultos] = useState(initialData?.bultos ?? 1);
  const [adrecaLliurament, setAdrecaLliurament] = useState(initialData?.adrecaLliurament ?? '');
  const [obsProduccio, setObsProduccio] = useState(initialData?.obsProduccio ?? '');
  const [obsLliurament, setObsLliurament] = useState(initialData?.obsLliurament ?? '');
  const [lines, setLines] = useState<LineDraft[]>(initialData?.linies ?? []);
  // Qué líneas tiene "tocadas" el usuario en esta sesión de edición — se
  // marca EXPLÍCITAMENTE en el momento de la acción (updateLine/afegir
  // línia), nunca se infiere comparando valores más tarde. Evita cualquier
  // falso positivo por comparación de tipo/formato: si el id no está acá,
  // el usuario no tocó esa línea, punto.
  const [dirtyLineIds, setDirtyLineIds] = useState<Set<number>>(new Set());
  // Mateix criteri que dirtyLineIds: es marca EXPLÍCITAMENT a l'acció de
  // l'usuari (cada onChange de capçalera), mai comparant valors contra
  // initialData més tard — evita falsos positius de tipus/format.
  const [headerTouched, setHeaderTouched] = useState(false);
  // Cache de "aquesta tarifa cobreix aquest producte?" (avís preventiu de
  // preu, ver resolvePriceRisk) — clau `${tarifaId}:${producteId}`, mai
  // s'esborra durant la sessió del formulari: si l'usuari torna a una
  // combinació ja consultada (per exemple, canvia de tarifa i torna a la
  // d'abans), es reaprofita sense repetir la crida a GET /tarifes/matriu.
  const [tariffCoverage, setTariffCoverage] = useState<Map<string, TariffCoverageStatus>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [lineToDelete, setLineToDelete] = useState<LineDraft | null>(null);
  const [lineDeleteError, setLineDeleteError] = useState<string | null>(null);
  const [isDeletingLine, setIsDeletingLine] = useState(false);

  function handleClientChange(id: number | null) {
    setHeaderTouched(true);
    setClientId(id);
    const client = clients.find((item) => item.id === id);
    if (!tariffTouched) {
      setTarifaId(client?.tarifa?.id ?? null);
    }
    // La fitxa del client pot no tenir població informada — en aquest cas
    // es deixa buit, mai undefined/error.
    if (!poblacioTouched) {
      setPoblacioDesti(client?.poblacio ?? '');
    }
  }

  function updateLine(id: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
    setDirtyLineIds((current) => (current.has(id) ? current : new Set(current).add(id)));
  }

  function addLine() {
    const newLine = createEmptyLine(lines.length + 1);
    setLines((current) => [...current, newLine]);
    setDirtyLineIds((current) => new Set(current).add(newLine.id));
  }

  function removeLine(line: LineDraft) {
    // Línia nova (nunca persistida): sólo se saca del borrador local, no
    // hay nada que borrar en el backend.
    if (mode === 'create' || line.id < 0) {
      setLines((current) => current.filter((item) => item.id !== line.id));
      setDirtyLineIds((current) => {
        if (!current.has(line.id)) return current;
        const next = new Set(current);
        next.delete(line.id);
        return next;
      });
      return;
    }
    // Línia existente en modo edición: DELETE real, con confirmación.
    setLineDeleteError(null);
    setLineToDelete(line);
  }

  async function handleConfirmDeleteLine() {
    if (!lineToDelete || !onDeleteLine) return;
    setIsDeletingLine(true);
    setLineDeleteError(null);
    try {
      await onDeleteLine(lineToDelete.id);
      setLines((current) => current.filter((item) => item.id !== lineToDelete.id));
      setLineToDelete(null);
    } catch (caught) {
      setLineDeleteError(
        caught instanceof Error ? caught.message : "No s'ha pogut eliminar la línia.",
      );
    } finally {
      setIsDeletingLine(false);
    }
  }

  const totalOrderedWeightKg = lines.reduce((sum, line) => sum + Number(line.kgDemanats), 0);

  // Regles 1-6, recalculades sencer cada render contra les 3 dates de
  // capçalera vigents (no comparant només la que s'acaba de tocar) — es
  // reflecteix en temps real als TextField/línies de sota via el prop
  // `error`, i és la MATEIXA constant que consulta submit() més avall
  // (no es recalcula per separat — elimina qualsevol possibilitat de
  // desincronització entre el que es pinta i el que es valida).
  const headerDateErrors = validateHeaderDates(dataComanda, dataLliurament, dataExpedicio);
  const hasLineDateErrors = lines.some(
    (line) =>
      validateLineDate(line.dataProduccio, dataComanda, dataLliurament, dataExpedicio) !==
      undefined,
  );
  const hasDateErrors = Object.keys(headerDateErrors).length > 0 || hasLineDateErrors;

  // Segona capa, independent del return anticipat dins submit(): avisa al
  // pare perquè pugui deshabilitar el seu propi botó "Desar" mentre hi
  // hagi dates en conflicte — així un click ni arriba a disparar submit().
  useEffect(() => {
    onDateErrorsChange?.(hasDateErrors);
  }, [hasDateErrors, onDateErrorsChange]);

  // isDirty = capçalera tocada O alguna línia tocada/afegida/eliminada
  // (dirtyLineIds) — eliminar una línia existent (mode edit) NO hi compta
  // (és un DELETE real i immediat, ver removeLine, no una part pendent de
  // "Desar" que es pugui perdre en navegar).
  const isDirty = headerTouched || dirtyLineIds.size > 0;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Avís preventiu de preu (ver resolvePriceRisk) — quan hi ha tarifa
  // vigent i el producte d'una línia no té `preuVenda` de respaldo, l'únic
  // cas amb risc cert que encara falta resoldre és si aquesta tarifa
  // concreta cobreix aquest producte concret. Es resol amb GET
  // /tarifes/matriu?cerca=<codi> (mateix endpoint que Llistat de Tarifes),
  // amb `cerca` fent coincidència EXACTA (regla 3.1) — per això `mida` no
  // necessita ser gran, però es deixa un marge (50) per si dos productes
  // comparteixen descripció exacta i cal desempatar per producteId.
  useEffect(() => {
    if (tarifaId === null) return;

    const missing = new Map<string, ProducteApi>();
    for (const line of lines) {
      if (line.producte === null) continue;
      const product = products.find((p) => p.id === line.producte!.id);
      if (!product || product.preuVenda !== null) continue;
      const key = tariffCoverageKey(tarifaId, product.id);
      if (!tariffCoverage.has(key)) missing.set(key, product);
    }
    if (missing.size === 0) return;

    let cancelled = false;
    const timeoutId = setTimeout(() => {
      void Promise.all(
        Array.from(missing.entries()).map(async ([key, product]) => {
          try {
            const resposta = await api.get<{ dades: FilaMatriuTarifesApi[] }>('/tarifes/matriu', {
              cerca: product.codi ?? product.descripcio,
              mida: 50,
            });
            const fila = resposta.dades.find((d) => d.producteId === product.id);
            const preu = fila?.preus[String(tarifaId)] ?? null;
            return [key, preu !== null ? ('covered' as const) : ('not-covered' as const)] as const;
          } catch {
            // Error de xarxa: no s'afirma res (la key queda fora de la
            // cache) — el proper efecte que la detecti com a "missing" la
            // tornarà a intentar, en comptes d'assumir "no coberta".
            return null;
          }
        }),
      ).then((results) => {
        if (cancelled) return;
        setTariffCoverage((current) => {
          const next = new Map(current);
          for (const result of results) if (result) next.set(result[0], result[1]);
          return next;
        });
      });
    }, TARIFF_COVERAGE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [lines, tarifaId, products, tariffCoverage]);

  useImperativeHandle(ref, () => ({
    submit: () => {
      if (!clientId) {
        setError('Cal seleccionar un client.');
        return;
      }

      if (mode === 'create' && !origenCodi) {
        setError('Cal seleccionar un origen.');
        return;
      }

      if (hasDateErrors) {
        setError(
          'Hi ha dates inconsistents al formulari — revisa els missatges marcats en vermell abans de desar.',
        );
        return;
      }

      // Issue #16 — dataComanda és obligatòria sempre (POST i PATCH la
      // rebutgen buida); dataLliurament només ho és en creació (PATCH
      // encara la deixa buidar en comandes existents).
      if (!dataComanda) {
        setError('Cal indicar la Data comanda.');
        return;
      }
      if (mode === 'create' && !dataLliurament) {
        setError('Cal indicar la Data lliurament.');
        return;
      }

      setError(null);

      // Fix urgent (pèrdua de dades real) — abans, aquest mateix filtre es
      // deia `validLines` i descartava en silenci qualsevol línia amb
      // producte triat però unitatsDemanades <= 0 (el default d'una línia
      // nova és "0", n'hi ha prou amb triar el producte i no tocar
      // unitats): la línia desapareixia del guardat sense cap avís —
      // l'usuari creia que s'havia guardat. Una línia amb producte triat és
      // una línia que l'usuari ha tocat de veritat; si li falta alguna
      // cosa, s'ha de bloquejar el guardat amb un missatge, mai descartar-la
      // en silenci. Només les línies COMPLETAMENT buides (producte === null,
      // mai tocades — les files de sobra sense usar) es descarten sense
      // avís, tal com ja passava.
      const touchedLines = lines.filter((line) => line.producte !== null);
      if (touchedLines.some((line) => Number(line.unitatsDemanades) <= 0)) {
        setError('Cal indicar les unitats demanades de cada línia abans de desar.');
        return;
      }

      // Issue #21 — dataProduccio de línia ja no és obligatòria (revertia
      // issue #16): `newLines` es manté (es reutilitza més avall per a
      // `lineChanges.novaLinies`), només es treu el bloqueig de submit.
      const newLines =
        mode === 'create'
          ? touchedLines
          : touchedLines.filter((line) => dirtyLineIds.has(line.id) && line.id < 0);

      // En edición, las línias nuevas/editadas se guardan por su propio
      // endpoint (POST/PATCH .../linies), nunca embebidas en el
      // PATCH de cabecera. En creación siguen viajando dentro de
      // ComandaCreacioApi.linies (embed original), lineChanges queda vacío.
      const lineChanges: OrderLineChanges =
        mode === 'edit'
          ? {
              novaLinies: newLines.map(toLiniaCreacio),
              liniesEditades: touchedLines
                .filter((line) => dirtyLineIds.has(line.id) && line.id > 0)
                .map((line) => ({ liniaId: line.id, patch: toLiniaEdicio(line) })),
            }
          : { novaLinies: [], liniesEditades: [] };

      void onSave(
        {
          clientId,
          // Creació: origenCodi ja validat non-null més amunt. Edició: sólo
          // se manda si el usuario lo tocó de verdad (origenTouched) — si
          // no, `null` (ver JSDoc de OrderFormValues.origen en useOrders.ts:
          // editOrder omite la clave del PATCH en ese caso, en vez de
          // reenviar el valor actual, que el backend rechazaría si hoy es
          // "manual").
          origen: mode === 'create' ? origenCodi : origenTouched ? origenCodi : null,
          tarifaId,
          transportistaId,
          // Issue #16 — sempre non-buida en aquest punt (validat a dalt).
          // `dataProduccio` de capçalera ja NO viatja des d'acá — es
          // sintetitza a useOrders.ts (createOrder/editOrder) a partir
          // d'aquest mateix `dataComanda` (fusió de conceptes).
          dataComanda: `${dataComanda}T00:00:00Z`,
          dataExpedicio: dataExpedicio ? `${dataExpedicio}T00:00:00Z` : null,
          dataLliurament: dataLliurament ? `${dataLliurament}T00:00:00Z` : null,
          bultos,
          obsProduccio: obsProduccio || null,
          obsLliurament: obsLliurament || null,
          poblacioDesti: poblacioDesti || null,
          adrecaLliurament: adrecaLliurament || null,
          estat,
          linies: mode === 'create' ? touchedLines.map(toLiniaCreacio) : [],
        },
        lineChanges,
      );
    },
  }));

  const clientDisplayValue = clientId
    ? ((clients.find((item) => item.id === clientId) &&
        clientLabel(clients.find((item) => item.id === clientId)!)) ??
      '')
    : '';

  const tariffOptions = [NO_TARIFF, ...tariffs.map((item) => tariffLabel(item))];
  const tariffValue = tarifaId
    ? ((tariffs.find((item) => item.id === tarifaId) &&
        tariffLabel(tariffs.find((item) => item.id === tarifaId)!)) ??
      NO_TARIFF)
    : NO_TARIFF;

  const carrierOptions = [NO_CARRIER, ...carriers.map((item) => carrierLabel(item))];
  const carrierValue = transportistaId
    ? ((carriers.find((item) => item.id === transportistaId) &&
        carrierLabel(carriers.find((item) => item.id === transportistaId)!)) ??
      NO_CARRIER)
    : NO_CARRIER;

  // Manté visible l'estat real quan ja és amb_incidencia (no forma part de
  // ESTAT_OPTIONS_SELECCIONABLES, ver comentari a dalt) — mai s'hi pot
  // TRIAR cap a ella des d'aquest selector, només es mostra si ja hi és.
  const estatOptions = ESTAT_OPTIONS_SELECCIONABLES.includes(estat)
    ? ESTAT_OPTIONS_SELECCIONABLES
    : [estat, ...ESTAT_OPTIONS_SELECCIONABLES];

  // "manual" (valor històric) mai apareix com a opció triable
  // (CODIS_ORIGEN_ELEGIBLES dalt), ni en creació ni en edició — reassignar
  // l'origen d'un pedido ja creat només pot anar cap a un d'aquests 4.
  const eligibleOrigins = origins.filter((origin) => CODIS_ORIGEN_ELEGIBLES.includes(origin.codi));
  // En creació, "Selecciona origen..." és una opció triable més (cap valor
  // inicial real). En edició NO s'ofereix: el pedido sempre té un origen
  // real ja carregat, no té sentit poder "buidar-lo" triant-la.
  const originOptions =
    mode === 'create'
      ? [NO_ORIGIN, ...eligibleOrigins.map((origin) => origin.nom)]
      : eligibleOrigins.map((origin) => origin.nom);
  // `origenCodi` pot ser "manual" en edició (valor històric real però no
  // elegible) — es resol contra el llistat COMPLET `origins`, no
  // només `eligibleOrigins`, perquè SimpleDropdown el pugui MOSTRAR igual
  // encara que no estigui entre les `options` triables (mateix cuidado que
  // Rendiments Porcs: un value que no està a la llista d'opcions no trenca
  // ni es reseteja sol). Si `origins` encara no ha carregat, cau al propi
  // codi cru en comptes de deixar el camp buit.
  const originValue = origenCodi
    ? (origins.find((origin) => origin.codi === origenCodi)?.nom ?? origenCodi)
    : NO_ORIGIN;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-base font-bold text-gray-900">Capçalera</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            label="Núm. comanda"
            value={mode === 'edit' ? (initialData?.num ?? '') : ''}
            placeholder={mode === 'create' ? '(es generarà en desar)' : undefined}
            disabled
          />
          <AsyncCombobox
            label="Client"
            value={clientId}
            displayValue={clientDisplayValue}
            placeholder={NO_CLIENT}
            disabled={isFrozen}
            loadOptions={loadClientOptions}
            onChange={(option) => handleClientChange(option?.id ?? null)}
          />
          <SimpleDropdown
            label="Origen"
            options={originOptions}
            value={originValue}
            onChange={(label) => {
              if (isFrozen) return;
              setHeaderTouched(true);
              if (mode === 'edit') setOrigenTouched(true);
              const origin = eligibleOrigins.find((item) => item.nom === label);
              setOrigenCodi(origin?.codi ?? null);
            }}
          />
          <SimpleDropdown
            label="Estat"
            options={estatOptions.map((value) => ESTAT_LABELS[value]!)}
            value={ESTAT_LABELS[estat] ?? estat}
            onChange={(label) => {
              if (isFrozen) return;
              setHeaderTouched(true);
              const value = estatOptions.find((option) => ESTAT_LABELS[option] === label);
              if (value) setEstat(value);
            }}
          />

          <SimpleDropdown
            label="Tarifa"
            options={tariffOptions}
            value={tariffValue}
            onChange={(label) => {
              if (isFrozen) return;
              setHeaderTouched(true);
              setTariffTouched(true);
              const tariff = tariffs.find((item) => tariffLabel(item) === label);
              setTarifaId(tariff?.id ?? null);
            }}
          />

          <SimpleDropdown
            label="Transportista"
            options={carrierOptions}
            value={carrierValue}
            onChange={(label) => {
              if (isFrozen) return;
              setHeaderTouched(true);
              const carrier = carriers.find((item) => carrierLabel(item) === label);
              setTransportistaId(carrier?.id ?? null);
            }}
          />
          {/* Issue #16 — "Data producció" de capçalera va desaparèixer com
              a input separat: investigació confirmada, no s'usava en cap
              filtre/pantalla més que la
              pròpia validació de coherència (ara fusionada amb dataComanda,
              ver validateHeaderDates). Columna real comanda.dataComanda
              (NOT NULL), distinta de creat_en (mai exposada a l'API).
              Obligatòria: sense default al backend, es precarrega amb avui
              (ver `today()`), editable abans de desar. El de cada LÍNIA
              (input més avall, "Data producció" dins de cada fila) és un
              concepte real i distint que NO es toca. */}
          <TextField
            label="Data comanda"
            type="date"
            disabled={isFrozen}
            value={dataComanda}
            onChange={(event) => {
              setHeaderTouched(true);
              setDataComanda(event.target.value);
            }}
            error={headerDateErrors.dataComanda}
          />
          <TextField
            label="Data expedició"
            type="date"
            disabled={isFrozen}
            value={dataExpedicio}
            onChange={(event) => {
              setHeaderTouched(true);
              setDataExpedicio(event.target.value);
            }}
            error={headerDateErrors.dataExpedicio}
          />
          <TextField
            label="Data lliurament"
            type="date"
            disabled={isFrozen}
            value={dataLliurament}
            onChange={(event) => {
              setHeaderTouched(true);
              setDataLliurament(event.target.value);
            }}
          />
          <TextField
            label="Núm. bultos"
            type="number"
            disabled={isFrozen}
            value={bultos ?? 0}
            onChange={(event) => {
              setHeaderTouched(true);
              setBultos(Number(event.target.value));
            }}
          />
          <TextField
            label="Població de destí"
            disabled={isFrozen}
            value={poblacioDesti}
            onChange={(event) => {
              setHeaderTouched(true);
              setPoblacioTouched(true);
              setPoblacioDesti(event.target.value);
            }}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4">
          <TextField
            label="Adreça de lliurament"
            disabled={isFrozen}
            value={adrecaLliurament}
            onChange={(event) => {
              setHeaderTouched(true);
              setAdrecaLliurament(event.target.value);
            }}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-gray-900">Observacions de producció</span>
            <textarea
              value={obsProduccio}
              disabled={isFrozen}
              onChange={(event) => {
                setHeaderTouched(true);
                setObsProduccio(event.target.value);
              }}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-gray-900">Observacions de lliurament</span>
            <textarea
              value={obsLliurament}
              disabled={isFrozen}
              onChange={(event) => {
                setHeaderTouched(true);
                setObsLliurament(event.target.value);
              }}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
            />
          </label>
        </div>

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">Línies</h2>
          <button
            type="button"
            disabled={isFrozen}
            onClick={addLine}
            className="flex items-center gap-2 rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
          >
            <Plus className="h-4 w-4" />
            Afegir línia
          </button>
        </div>

        <div className="flex flex-col gap-3 xl:hidden">
          {lines.map((line) => (
            <LineFormCard
              key={line.id}
              line={line}
              products={products}
              tarifaId={tarifaId}
              tariffCoverage={tariffCoverage}
              disabled={isFrozen}
              headerDates={{ dataComanda, dataLliurament, dataExpedicio }}
              onUpdate={(patch) => updateLine(line.id, patch)}
              onRemove={() => removeLine(line)}
            />
          ))}
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-right text-sm font-semibold text-gray-900">
            Total pes demanat (kg): {totalOrderedWeightKg.toFixed(3).replace('.', ',')}
          </div>
        </div>

        <div className="hidden overflow-x-auto rounded-lg border border-gray-200 xl:block">
          <table className="w-full table-fixed text-sm">
            <thead className="border-b border-gray-200">
              <tr>
                <th className="w-[13%] px-1.5 py-2 text-left font-medium text-gray-500 break-words">
                  Producte
                </th>
                <th className="w-[9%] px-1.5 py-2 text-left font-medium text-gray-500 break-words">
                  Categoria
                </th>
                <th className="w-[9%] px-1.5 py-2 text-left font-medium text-gray-500 break-words">
                  Format
                </th>
                <th className="w-[8%] px-1.5 py-2 text-left font-medium text-gray-500 break-words">
                  Envasat
                </th>
                <th className="w-[13%] px-1.5 py-2 text-left font-medium text-gray-500 break-words">
                  Data producció
                </th>
                <th className="w-[9%] px-1.5 py-2 text-right font-medium text-gray-500 break-words">
                  Unitats demanades
                </th>
                <th className="w-[9%] px-1.5 py-2 text-right font-medium text-gray-500 break-words">
                  Unitats lliurades
                </th>
                <th className="w-[8%] px-1.5 py-2 text-right font-medium text-gray-500 break-words">
                  Pes demanat (kg)
                </th>
                <th className="w-[7%] px-1.5 py-2 text-right font-medium text-gray-500 break-words">
                  Pes lliurat (kg)
                </th>
                <th className="w-[7%] px-1.5 py-2 text-left font-medium text-gray-500 break-words">
                  Obs. producció
                </th>
                <th className="w-[8%] px-1.5 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const product = products.find((p) => p.id === line.producte?.id);
                const lineDateError = validateLineDate(
                  line.dataProduccio,
                  dataComanda,
                  dataLliurament,
                  dataExpedicio,
                );
                return (
                  <tr key={line.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-1.5 py-2">
                      <AsyncCombobox
                        value={line.producte?.id ?? null}
                        displayValue={
                          line.producte ? productLabel(line.producte as ProducteApi) : ''
                        }
                        placeholder={NO_PRODUCT}
                        disabled={isFrozen || line.id > 0}
                        debounceMs={0}
                        loadOptions={loadLocalProductOptions(products)}
                        onChange={(option) => {
                          const selected = option
                            ? products.find((p) => p.id === option.id)
                            : undefined;
                          updateLine(line.id, applyProduct({ ...line }, selected));
                        }}
                      />
                      {resolvePriceRisk(line, tarifaId, products, tariffCoverage).risk && (
                        <p className="mt-1 text-xs text-amber-700">
                          Sense preu — cal completar més endavant.
                        </p>
                      )}
                    </td>
                    <td className="px-1.5 py-2 break-words text-gray-500">
                      {line.categoria ?? '—'}
                    </td>
                    <td className="px-1.5 py-2 break-words text-gray-500">{line.format ?? '—'}</td>
                    <td className="px-1.5 py-2 break-words text-gray-500">{line.envasat ?? '—'}</td>
                    <td className="px-1.5 py-2">
                      <input
                        type="date"
                        disabled={isFrozen}
                        value={line.dataProduccio ? line.dataProduccio.slice(0, 10) : ''}
                        onChange={(event) =>
                          updateLine(line.id, {
                            dataProduccio: event.target.value
                              ? `${event.target.value}T00:00:00Z`
                              : null,
                          })
                        }
                        className="w-full rounded-md border border-gray-300 px-1.5 py-1 text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                      />
                      {lineDateError && (
                        <p className="mt-1 text-xs text-red-600">{lineDateError}</p>
                      )}
                      {/* Issue #21 — mateix criteri que a la vista de card:
                          indicador informatiu, no una incidència; només per a
                          línies ja existents (line.id > 0). */}
                      {line.id > 0 && line.dataProduccio === null && (
                        <div className="mt-1">
                          <Badge variant="neutral">Sense data assignada</Badge>
                        </div>
                      )}
                    </td>
                    <td className="px-1.5 py-2">
                      <DecimalInput
                        disabled={isFrozen}
                        value={line.unitatsDemanades}
                        onChange={(value) => {
                          const recalculated = calculateOrderedWeightKg(Number(value), product);
                          updateLine(line.id, {
                            unitatsDemanades: value,
                            kgDemanats:
                              !line.kgEditable && recalculated.isCalculated
                                ? recalculated.value.toFixed(3)
                                : line.kgDemanats,
                          });
                        }}
                        className="w-full rounded-md border border-gray-300 px-1.5 py-1 text-right text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </td>
                    {/* Sólo lectura: ver nota de Unitats/Pes lliurades en LineFormCard. */}
                    <td className="px-1.5 py-2 text-right text-gray-500">
                      {formatDecimal(line.unitatsLliurades, 2)}
                    </td>
                    <td className="px-1.5 py-2">
                      {!line.kgEditable ? (
                        <input
                          type="text"
                          value={Number(line.kgDemanats).toFixed(3).replace('.', ',')}
                          disabled
                          className="w-full rounded-md border border-gray-200 bg-gray-50 px-1.5 py-1 text-right text-sm text-gray-400"
                        />
                      ) : (
                        <DecimalInput
                          disabled={isFrozen}
                          value={line.kgDemanats}
                          onChange={(value) => updateLine(line.id, { kgDemanats: value })}
                          onBlur={() =>
                            updateLine(line.id, {
                              kgDemanats: parseDecimalInput(line.kgDemanats, 3),
                            })
                          }
                          className="w-full rounded-md border border-gray-300 px-1.5 py-1 text-right text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                        />
                      )}
                    </td>
                    <td className="px-1.5 py-2 text-right text-gray-500">{line.kgLliurats}</td>
                    <td className="px-1.5 py-2">
                      <textarea
                        value={line.obsProduccio ?? ''}
                        disabled={isFrozen}
                        onChange={(event) =>
                          updateLine(line.id, { obsProduccio: event.target.value })
                        }
                        rows={1}
                        className="w-full rounded-md border border-gray-300 px-1.5 py-1 text-sm text-gray-900 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </td>
                    <td className="px-1.5 py-2">
                      <IconButton
                        variant="delete"
                        label="Eliminar línia"
                        onClick={() => removeLine(line)}
                        disabled={isFrozen}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-200 bg-gray-50">
                <td
                  colSpan={11}
                  className="px-2 py-3 text-right text-sm font-semibold text-gray-900"
                >
                  Total pes demanat (kg): {totalOrderedWeightKg.toFixed(3).replace('.', ',')}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <ConfirmDialog
        isOpen={lineToDelete !== null}
        title="Eliminar línia"
        message={
          lineToDelete
            ? `Vols eliminar la línia de "${lineToDelete.producte?.descripcio ?? '—'}"?`
            : ''
        }
        confirmLabel="Eliminar"
        cancelLabel="Cancel·lar"
        errorMessage={lineDeleteError}
        isConfirming={isDeletingLine}
        onConfirm={handleConfirmDeleteLine}
        onCancel={() => {
          setLineToDelete(null);
          setLineDeleteError(null);
        }}
      />
    </div>
  );
});
