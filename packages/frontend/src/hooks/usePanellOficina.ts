'use client';

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type FilaPanellOficinaApi,
  type Paginacio,
  type PanellOficinaApi,
  type TotalsPanellOficinaApi,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

/**
 * Els 8 filtres reals de GET /panells/oficina (contrato §4.6, confirmat
 * contra panells.ts): tarifaId/poblacioDesti i els rangos
 * dataComandaDes/Fins i dataLliuramentDes/Fins.
 */
export type OfficePanelFilters = {
  estat?: string;
  transportistaId?: number;
  clientId?: number;
  tarifaId?: number;
  poblacioDesti?: string;
  dataExpedicioDes?: string;
  dataExpedicioFins?: string;
  dataComandaDes?: string;
  dataComandaFins?: string;
  dataLliuramentDes?: string;
  dataLliuramentFins?: string;
};

type UsePanellOficinaResult = {
  data: FilaPanellOficinaApi[];
  totals: TotalsPanellOficinaApi | null;
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
};

// Paginació real (MIDA_PAGINA_LLISTATS/pàgina) — el volum es controla amb els filtres
// server-side, mateix criteri que useOrders.ts.
const MIDA_PAGINA = MIDA_PAGINA_LLISTATS;

export function usePanellOficina(filters: OfficePanelFilters = {}): UsePanellOficinaResult {
  const [data, setData] = useState<FilaPanellOficinaApi[]>([]);
  const [totals, setTotals] = useState<TotalsPanellOficinaApi | null>(null);
  const [paginacio, setPaginacio] = useState<Paginacio | null>(null);
  const [pagina, setPagina] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const filtersKey = JSON.stringify(filters);

  // Ajustat durant el render (patró oficial de React per "adjusting state
  // when a prop changes": https://react.dev/learn/you-might-not-need-an-effect),
  // no en un efecte — mateix comportament que abans, sense el render
  // intermedi amb la pàgina vella.
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (filtersKey !== prevFiltersKey) {
    setPrevFiltersKey(filtersKey);
    setPagina(1);
  }

  useEffect(() => {
    let cancelled = false;
    // Fetch a un sistema extern (API): el reset síncron d'isLoading/error
    // just abans de cridar-lo és el patró de React per a data fetching en
    // efectes, no un valor derivable durant el render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    api
      .get<PanellOficinaApi>('/panells/oficina', { mida: MIDA_PAGINA, pagina, ...filters })
      .then((resposta) => {
        if (!cancelled) {
          setData(resposta.dades);
          setTotals(resposta.totals);
          setPaginacio(resposta.paginacio);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof ApiError
              ? caught
              : new ApiError('ERROR_XARXA', 'Error desconegut.', null),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, pagina, filtersKey]);

  const refetch = () => setReloadToken((token) => token + 1);

  // Hallazgo A (auditoria de paginació) — corregeix `pagina` si un canvi
  // deixa l'usuari en una pàgina que ja no existeix.
  usePageClamp(paginacio, setPagina);

  return { data, totals, paginacio, pagina, setPagina, isLoading, error, refetch };
}
