'use client';

import { useState } from 'react';
import { DataCard, DataCardActions, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { DecimalInput } from '@/components/ui/DecimalInput';
import { useEditableRow } from '@/hooks/useEditableRow';
import type { LliuramentSaveResult } from '@/hooks/usePanellEmpaquetat';
import type { FilaPanellEmpaquetatApi } from '@/lib/api';
import { formatData } from '@/lib/dates';
import { formatDecimal, parseDecimalInput } from '@/lib/decimals';

// Fila (taula) i targeta (mòbil) d'una línia amb unitats i quilos lliurats
// editables. Vivien a packaging/page.tsx; es comparteixen des de la tasca 41
// perquè el Panell de Compres edita les mateixes línies amb la mateixa regla
// (PATCH .../lliurament: els dos camps sempre junts, confirma en desar).

// "0" pla en comptes de "0.000"/"0.00" — mateix criteri que kgDemanats a
// Comandes, evita que el cursor caigui enmig dels decimals en fer clic.
// NOMÉS per a una línia encara NO confirmada (confirmatA === null): si ja
// es va confirmar una entrega abans (encara que casualment fos zero per
// una merma total), és un valor real ja resolt i es mostra tal qual, mai
// simplificat.
function initialDeliveredValue(value: string, confirmatA: string | null): string {
  return confirmatA === null && Number(value) === 0 ? '0' : value;
}

// Issue #19 — abans era sempre disabled (l'única forma de marcar-la era
// carregar unitats/kg i Guardar). Ara, si la línia ja està confirmada,
// aquest mateix checkbox és l'acció per desfer-la (onRequestUndo obre el
// ConfirmDialog, mai muta l'estat directament des d'acá). Sobre una línia
// encara pendent (confirmatA === null) segueix sent purament informatiu i
// disabled — no té sentit "desfer" una confirmació que mai va existir.
function WorkedCheckbox({
  confirmatA,
  onRequestUndo,
}: {
  confirmatA: string | null;
  onRequestUndo?: () => void;
}) {
  const isConfirmed = confirmatA !== null;
  return (
    <input
      type="checkbox"
      checked={isConfirmed}
      disabled={!isConfirmed}
      onChange={onRequestUndo}
      aria-label={isConfirmed ? 'Desfer confirmació de la línia' : 'Línia pendent'}
      className="h-4 w-4 rounded border-gray-300 text-ink disabled:cursor-not-allowed"
    />
  );
}

function leftBorderClass(confirmatA: string | null) {
  return confirmatA !== null ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-gray-200';
}

type Draft = { unitatsLliurades: string; kgLliurats: string };

type OnSaveLliurament = (
  comandaId: number,
  liniaId: number,
  unitatsLliurades: number,
  kgLliurats: string,
) => Promise<LliuramentSaveResult>;

/**
 * Què identifica la línia a la columna/subtítol variable: al Panell
 * Empaquetat, el client; al Panell de Compres (tasca 41), on les línies ja
 * surten sota el seu client, el número de comanda.
 */
type Identificador = 'client' | 'comanda';

function textIdentificador(line: FilaPanellEmpaquetatApi, identificador: Identificador): string {
  if (identificador === 'comanda') return line.num;
  return line.client ?? '—';
}

export function PackagingRow({
  line,
  onSave,
  onRequestUndo,
  identificador = 'client',
}: {
  line: FilaPanellEmpaquetatApi;
  onSave: OnSaveLliurament;
  onRequestUndo: (line: FilaPanellEmpaquetatApi) => void;
  identificador?: Identificador;
}) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const initialValues: Draft = {
    unitatsLliurades: initialDeliveredValue(line.unitatsLliurades, line.confirmatA),
    kgLliurats: initialDeliveredValue(line.kgLliurats, line.confirmatA),
  };

  const { draft, setField, save, isDirty } = useEditableRow(initialValues, async (values) => {
    // El PATCH exigeix els dos camps sempre junts (contrato §5) — encara
    // que la fila només hagi tocat un dels dos, es manda el valor actual
    // del que no es va tocar més el nou de l'altre.
    const unitatsLliurades = Number(values.unitatsLliurades);
    const kgLliurats = parseDecimalInput(values.kgLliurats, 3);

    setIsSaving(true);
    setFieldErrors({});
    setGeneralError(null);
    const result = await onSave(line.comandaId, line.liniaId, unitatsLliurades, kgLliurats);
    setIsSaving(false);

    if (!result.success) {
      setFieldErrors(result.fieldErrors);
      setGeneralError(result.generalError);
    }
  });

  return (
    <tr className="border-b border-gray-100 last:border-0">
      {/* Primera columna (petició d'Ari) i sempre visible: porta la franja
          de color pendent/enviada en tots els tamanys de pantalla. */}
      <td className={`${leftBorderClass(line.confirmatA)} px-3 py-3 break-words text-gray-700`}>
        {line.categoria ?? '—'}
      </td>
      <td className="hidden px-3 py-3 text-center xl:table-cell">
        <WorkedCheckbox
          confirmatA={line.confirmatA}
          onRequestUndo={line.confirmatA !== null ? () => onRequestUndo(line) : undefined}
        />
      </td>
      <td className="hidden px-3 py-3 break-words text-gray-900 xl:table-cell">
        {line.dataExpedicio ? formatData(line.dataExpedicio, false) : '—'}
      </td>
      <td className="hidden px-3 py-3 break-words text-gray-900 xl:table-cell">
        {line.dataLliurament ? formatData(line.dataLliurament, false) : '—'}
      </td>
      <td className="hidden px-3 py-3 break-words text-gray-900 xl:table-cell">
        {line.transportista ?? '—'}
      </td>
      <td className="px-3 py-3 break-words">
        <span className="font-semibold text-gray-900">{line.producte}</span>
      </td>
      {/* El número de comanda (Panell de Compres) es veu sempre: és el que
          distingeix les línies d'un mateix client. */}
      <td
        className={`px-3 py-3 break-words text-gray-900 ${identificador === 'comanda' ? '' : 'hidden xl:table-cell'}`}
      >
        {textIdentificador(line, identificador)}
      </td>
      {/* Tasca 7: observació d'empaquetat de la línia (ve de l'entrada de comandes). */}
      <td className="px-3 py-3 break-words text-gray-900">{line.obsEmpaquetat ?? ''}</td>
      <td className="px-3 py-3 text-right text-gray-900">
        {formatDecimal(line.unitatsDemanades, 2)}
      </td>
      <td className="px-3 py-3">
        <DecimalInput
          value={draft.unitatsLliurades}
          onChange={(value) => setField('unitatsLliurades', value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-right text-sm text-gray-900 focus:border-brand focus:outline-none"
        />
        {fieldErrors.unitatsLliurades && (
          <p className="mt-1 text-xs text-red-600">{fieldErrors.unitatsLliurades}</p>
        )}
      </td>
      <td className="px-3 py-3 text-right text-gray-900">{formatDecimal(line.kgDemanats, 3)}</td>
      <td className="px-3 py-3">
        <DecimalInput
          value={draft.kgLliurats}
          onChange={(value) => setField('kgLliurats', value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-right text-sm text-gray-900 focus:border-brand focus:outline-none"
        />
        {fieldErrors.kgLliurats && (
          <p className="mt-1 text-xs text-red-600">{fieldErrors.kgLliurats}</p>
        )}
      </td>
      <td className="px-3 py-3 text-center align-top">
        <button
          type="button"
          onClick={save}
          disabled={!isDirty || isSaving}
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
            isDirty && !isSaving
              ? 'bg-ink text-white hover:opacity-90'
              : 'cursor-not-allowed bg-gray-200 text-gray-400'
          }`}
        >
          {isSaving ? 'Desant...' : 'Desar'}
        </button>
        {generalError && <p className="mt-1 max-w-[140px] text-xs text-red-600">{generalError}</p>}
      </td>
    </tr>
  );
}

export function PackagingCard({
  line,
  onSave,
  onRequestUndo,
  identificador = 'client',
}: {
  line: FilaPanellEmpaquetatApi;
  onSave: OnSaveLliurament;
  onRequestUndo: (line: FilaPanellEmpaquetatApi) => void;
  identificador?: Identificador;
}) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const initialValues: Draft = {
    unitatsLliurades: initialDeliveredValue(line.unitatsLliurades, line.confirmatA),
    kgLliurats: initialDeliveredValue(line.kgLliurats, line.confirmatA),
  };

  const { draft, setField, save, isDirty } = useEditableRow(initialValues, async (values) => {
    const unitatsLliurades = Number(values.unitatsLliurades);
    const kgLliurats = parseDecimalInput(values.kgLliurats, 3);

    setIsSaving(true);
    setFieldErrors({});
    setGeneralError(null);
    const result = await onSave(line.comandaId, line.liniaId, unitatsLliurades, kgLliurats);
    setIsSaving(false);

    if (!result.success) {
      setFieldErrors(result.fieldErrors);
      setGeneralError(result.generalError);
    }
  });

  return (
    <div className="relative overflow-hidden rounded-xl">
      <div
        className={`absolute inset-y-0 left-0 w-1 ${line.confirmatA !== null ? 'bg-green-500' : 'bg-gray-200'}`}
      />
      <DataCard>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
              {line.categoria ?? '—'}
            </p>
            <p className="font-semibold text-gray-900">{line.producte}</p>
            <p className="text-sm text-gray-500">
              {identificador === 'comanda' ? `Comanda ${line.num}` : (line.client ?? '—')}
            </p>
          </div>
          <WorkedCheckbox
            confirmatA={line.confirmatA}
            onRequestUndo={line.confirmatA !== null ? () => onRequestUndo(line) : undefined}
          />
        </div>

        <div className="mt-3">
          <DataCardGrid>
            <DataCardField label="Data d'expedició">
              {line.dataExpedicio ? formatData(line.dataExpedicio, false) : '—'}
            </DataCardField>
            <DataCardField label="Data de lliurament">
              {line.dataLliurament ? formatData(line.dataLliurament, false) : '—'}
            </DataCardField>
            <DataCardField label="Transportista">{line.transportista ?? '—'}</DataCardField>
            <DataCardField label="Unitats demanades">
              {formatDecimal(line.unitatsDemanades, 2)}
            </DataCardField>
            <DataCardField label="Kilos demanats">
              {formatDecimal(line.kgDemanats, 3)}
            </DataCardField>
            <DataCardField label="Obs. empaquetat">{line.obsEmpaquetat ?? '—'}</DataCardField>
          </DataCardGrid>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-gray-500">Unitats lliurades</span>
            <DecimalInput
              value={draft.unitatsLliurades}
              onChange={(value) => setField('unitatsLliurades', value)}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
            {fieldErrors.unitatsLliurades && (
              <p className="text-xs text-red-600">{fieldErrors.unitatsLliurades}</p>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-gray-500">Kilos lliurats</span>
            <DecimalInput
              value={draft.kgLliurats}
              onChange={(value) => setField('kgLliurats', value)}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
            {fieldErrors.kgLliurats && (
              <p className="text-xs text-red-600">{fieldErrors.kgLliurats}</p>
            )}
          </label>
        </div>

        <DataCardActions>
          <button
            type="button"
            onClick={save}
            disabled={!isDirty || isSaving}
            className={`w-full rounded-full px-3 py-2 text-sm font-semibold ${
              isDirty && !isSaving
                ? 'bg-ink text-white hover:opacity-90'
                : 'cursor-not-allowed bg-gray-200 text-gray-400'
            }`}
          >
            {isSaving ? 'Desant...' : 'Desar'}
          </button>
        </DataCardActions>
        {generalError && <p className="mt-2 text-xs text-red-600">{generalError}</p>}
      </DataCard>
    </div>
  );
}
