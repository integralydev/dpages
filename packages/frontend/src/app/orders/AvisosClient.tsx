'use client';

import {
  TIPUS_INCIDENCIA_CLIENT,
  TIPUS_INCIDENCIA_SENSE_CLIENT,
  type TipusIncidenciaClient,
} from '@dpages/shared';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { ApiError, type IncidenciaComandaApi } from '@/lib/api';

/**
 * ADR-027: avisos del sync de la web sobre el CLIENT de la comanda («NIF
 * diferent», client no assignat). Es veuen fins que l'oficina els marca
 * «Revisat»; no canvien l'estat de la comanda.
 */
const TITOLS: Record<TipusIncidenciaClient, string> = {
  nif_diferent: 'NIF diferent',
  conflicte_identitat_client: 'Client no assignat',
  sense_dades_client: 'Client no assignat',
};

/**
 * Els detalls dels dos conflictes antics els escriu el sync en llenguatge
 * tècnic; a l'oficina se li explica què ha de fer. El de «NIF diferent» ja
 * està escrit per a l'oficina.
 */
function textAvis(incidencia: IncidenciaComandaApi): string {
  switch (incidencia.tipus) {
    case 'conflicte_identitat_client':
      return "Les dades de la comanda coincideixen amb un altre client i no s'ha pogut assignar automàticament. Tria el client a mà.";
    case 'sense_dades_client':
      return 'La comanda no porta ni NIF ni correu. Tria el client a mà.';
    default:
      return incidencia.detall;
  }
}

function esAvisClient(tipus: string): tipus is TipusIncidenciaClient {
  return (TIPUS_INCIDENCIA_CLIENT as readonly string[]).includes(tipus);
}

/**
 * Avisos per mostrar: els no revisats. Els de «client no assignat» només si
 * la comanda continua sense client (l'oficina el pot haver posat a mà).
 */
export function avisosClientOberts(
  incidencies: IncidenciaComandaApi[],
  teClient: boolean,
): IncidenciaComandaApi[] {
  return incidencies.filter(
    (inc) =>
      !inc.resolta &&
      esAvisClient(inc.tipus) &&
      !(teClient && (TIPUS_INCIDENCIA_SENSE_CLIENT as readonly string[]).includes(inc.tipus)),
  );
}

export function AvisosClient({
  incidencies,
  teClient,
  onRevisar,
}: {
  incidencies: IncidenciaComandaApi[];
  /** La comanda desada té client (no el que s'estigui editant sense desar). */
  teClient: boolean;
  /** Marca l'avís com a revisat (POST .../revisada). */
  onRevisar: (incidenciaId: string) => Promise<void>;
}) {
  const [enCurs, setEnCurs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const oberts = avisosClientOberts(incidencies, teClient);
  if (oberts.length === 0) return null;

  async function revisar(id: string) {
    setEnCurs(id);
    setError(null);
    try {
      await onRevisar(id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "No s'ha pogut marcar com a revisat.");
    } finally {
      setEnCurs(null);
    }
  }

  return (
    <div className="mb-6 flex flex-col gap-3">
      {oberts.map((avis) => (
        <div
          key={avis.id}
          className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-900">
              {TITOLS[avis.tipus as TipusIncidenciaClient]}
            </p>
            <p className="text-sm text-amber-800">{textAvis(avis)}</p>
          </div>
          <button
            type="button"
            onClick={() => void revisar(avis.id)}
            disabled={enCurs !== null}
            className="shrink-0 rounded-full border border-amber-400 bg-white px-4 py-1.5 text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {enCurs === avis.id ? 'Desant...' : 'Revisat'}
          </button>
        </div>
      ))}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
