'use client';

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type FilaPanellCompresApi,
  type Paginacio,
  type PanellCompresApi,
  type TotalsPanellCompresApi,
} from '@/lib/api';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';
import { usePageClamp } from './usePageClamp';
import type { PackagingPanelFilters } from './usePanellEmpaquetat';

type UsePanellCompresResult = {
  data: FilaPanellCompresApi[];
  totals: TotalsPanellCompresApi | null;
  paginacio: Paginacio | null;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  /** Torna a carregar sense passar per "Carregant..." (després de desar una línia). */
  refetch: () => void;
};

/**
 * Tasca 41: Panell de Compres, una fila per client amb la suma de les seves
 * línies (GET /panells/compres). Mateixos filtres que el Panell Empaquetat.
 * Paginat per clients. El detall de cada client el carrega
 * `usePanellEmpaquetat` amb `clientId`.
 */
export function usePanellCompres(filters: PackagingPanelFilters = {}): UsePanellCompresResult {
  const [data, setData] = useState<FilaPanellCompresApi[]>([]);
  const [totals, setTotals] = useState<TotalsPanellCompresApi | null>(null);
  const [paginacio, setPaginacio] = useState<Paginacio | null>(null);
  const [pagina, setPagina] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const filtersKey = JSON.stringify(filters);

  // "Carregant..." només quan canvien els filtres o la pàgina; un refetch
  // (desar una línia) refresca les xifres sense amagar la llista ni els
  // clients desplegats. Ajustat durant el render, mateix patró que
  // usePanellObradorAcumulat.ts.
  const clau = `${filtersKey}|${pagina}`;
  const [prevClau, setPrevClau] = useState(clau);
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (filtersKey !== prevFiltersKey) {
    setPrevFiltersKey(filtersKey);
    setPagina(1);
  }
  if (clau !== prevClau) {
    setPrevClau(clau);
    setIsLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .get<PanellCompresApi>('/panells/compres', { mida: MIDA_PAGINA_LLISTATS, pagina, ...filters })
      .then((resposta) => {
        if (!cancelled) {
          setData(resposta.dades);
          setTotals(resposta.totals);
          setPaginacio(resposta.paginacio);
          setError(null);
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

  usePageClamp(paginacio, setPagina);

  return {
    data,
    totals,
    paginacio,
    setPagina,
    isLoading,
    error,
    refetch: () => setReloadToken((token) => token + 1),
  };
}
