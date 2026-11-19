'use client';

import { useState } from 'react';
import { DateInput } from '@/components/ui/DateInput';
import { Modal } from '@/components/ui/Modal';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { api, ApiError, type ComandaDetallApi, type ComandaResumApi } from '@/lib/api';
import { ESTAT_LABELS } from '@/lib/comandaEstat';

const NO_CANVIAR = 'No canviar';

// "Amb incidència" no s'ofereix: marcar-la a mà demana un motiu propi de
// cada comanda (tasca 44, decidit amb el client el 17/11/2026).
const ESTATS_TRIABLES = Object.entries(ESTAT_LABELS).filter(([codi]) => codi !== 'amb_incidencia');

// Noms dels camps de data tal com els envia l'API → com els veu l'usuari.
const NOMS_CAMPS: Record<string, string> = {
  dataComanda: 'la data de comanda',
  dataProduccio: 'la data de producció',
  dataExpedicio: "la data d'expedició",
  dataLliurament: 'la data de lliurament',
};

/** Motiu llegible: el detall de l'API (quina data xoca) si n'hi ha, si no el missatge general. */
function motiuError(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "No s'ha pogut canviar.";
  const detall = caught.detalls?.[0];
  if (!detall) return caught.message;
  const camp = detall.camp.replace('linies[].', '');
  const text = detall.missatge.replace(/\bdata[A-Z]\w*/g, (nom) => NOMS_CAMPS[nom] ?? nom);
  const nomCamp = NOMS_CAMPS[camp];
  // Els detalls de línia ja porten l'etiqueta ("línia núm. 12: ..."); els de
  // capçalera només diuen el problema, sense el camp.
  return detall.camp.startsWith('linies') || !nomCamp ? text : `${nomCamp} ${text}`;
}

interface ErrorComanda {
  num: string;
  missatge: string;
}

interface Resultat {
  canviades: number;
  errors: ErrorComanda[];
}

/**
 * Tasca 44: canvia a la vegada l'estat i/o la data de producció de les
 * comandes seleccionades. Cada comanda passa pel mateix PATCH que fa servir
 * la seva fitxa, així que s'apliquen les mateixes regles (congelada, dates
 * coherents). La data de producció s'aplica també a totes les línies, que és
 * la que fan servir els panells d'Obrador i Producció. Si una comanda falla,
 * les altres es canvien igual i al final es mostra un resum.
 */
export function CanviMassiuDialog({
  comandes,
  isOpen,
  onClose,
}: {
  comandes: ComandaResumApi[];
  isOpen: boolean;
  /** `hiHaCanvis`: true si s'ha canviat alguna comanda (cal recarregar la llista). */
  onClose: (hiHaCanvis: boolean) => void;
}) {
  const [estatLabel, setEstatLabel] = useState(NO_CANVIAR);
  const [dataProduccio, setDataProduccio] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [resultat, setResultat] = useState<Resultat | null>(null);

  const estat = ESTATS_TRIABLES.find(([, label]) => label === estatLabel)?.[0];
  const hiHaAlgunCanvi = estat !== undefined || dataProduccio !== '';

  function tancar() {
    const hiHaCanvis = (resultat?.canviades ?? 0) > 0;
    setEstatLabel(NO_CANVIAR);
    setDataProduccio('');
    setResultat(null);
    onClose(hiHaCanvis);
  }

  async function aplicar() {
    setIsApplying(true);
    const cos = {
      ...(estat !== undefined ? { estat } : {}),
      ...(dataProduccio !== '' ? { dataProduccio, aplicarDataProduccioALinies: true } : {}),
    };
    let canviades = 0;
    const errors: ErrorComanda[] = [];
    // Una per una: així cada error queda lligat a la seva comanda.
    for (const comanda of comandes) {
      try {
        await api.patch<ComandaDetallApi>(`/comandes/${comanda.id}`, cos);
        canviades += 1;
      } catch (caught) {
        errors.push({
          num: comanda.num,
          missatge: motiuError(caught),
        });
      }
    }
    setResultat({ canviades, errors });
    setIsApplying(false);
  }

  if (resultat) {
    return (
      <Modal isOpen={isOpen} onClose={tancar} title="Canvi d'estat i data">
        <p className="text-sm text-gray-600">
          {resultat.canviades === 1
            ? "S'ha canviat 1 comanda."
            : `S'han canviat ${resultat.canviades} comandes.`}
        </p>
        {resultat.errors.length > 0 && (
          <div className="mt-3 text-sm text-red-600">
            <p>
              {resultat.errors.length === 1
                ? "1 comanda no s'ha pogut canviar:"
                : `${resultat.errors.length} comandes no s'han pogut canviar:`}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {resultat.errors.map((error) => (
                <li key={error.num}>
                  {error.num}: {error.missatge}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-6 flex items-center justify-end">
          <button
            type="button"
            onClick={tancar}
            className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Tancar
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={tancar} title="Canvi d'estat i data">
      <p className="text-sm text-gray-600">
        {comandes.length === 1
          ? 'Canvia la comanda seleccionada.'
          : `Canvia les ${comandes.length} comandes seleccionades.`}{' '}
        El que deixis sense triar no es toca.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <SimpleDropdown
          label="Estat"
          options={ESTATS_TRIABLES.map(([, label]) => label)}
          value={estatLabel}
          onChange={setEstatLabel}
          allLabel={NO_CANVIAR}
        />
        <DateInput label="Data de producció" value={dataProduccio} onChange={setDataProduccio} />
        {dataProduccio !== '' && (
          <p className="text-xs text-gray-500">
            La data de producció s&apos;aplica també a totes les línies de cada comanda.
          </p>
        )}
      </div>
      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={tancar}
          className="text-sm font-medium text-gray-500 hover:text-gray-700"
        >
          Cancel·lar
        </button>
        <button
          type="button"
          onClick={aplicar}
          disabled={isApplying || !hiHaAlgunCanvi}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isApplying ? 'Aplicant...' : 'Aplicar'}
        </button>
      </div>
    </Modal>
  );
}
