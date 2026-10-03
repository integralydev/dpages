'use client';

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type FilaPanellObradorAcumulatApi,
  type PanellObradorAcumulatApi,
  type TotalsPanellObradorApi,
} from '@/lib/api';
import type { WorkshopPanelFilters } from './usePanellObrador';

type UsePanellObradorAcumulatResult = {
  data: FilaPanellObradorAcumulatApi[];
  totals: TotalsPanellObradorApi | null;
  isLoading: boolean;
  error: ApiError | null;
  /** Torna a carregar sense passar per "Carregant..." (després de marcar línies). */
  refetch: () => void;
};

/**
 * Tasca 29 (03/10/2026): vista per defecte del Panell Obrador, una fila per
 * producte amb la suma de les línies que compleixen els filtres
 * (GET /panells/obrador/acumulat). Sense paginació: com a molt, una fila
 * per article.
 */
export function usePanellObradorAcumulat(
  filters: WorkshopPanelFilters = {},
): UsePanellObradorAcumulatResult {
  const [data, setData] = useState<FilaPanellObradorAcumulatApi[]>([]);
  const [totals, setTotals] = useState<TotalsPanellObradorApi | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const filtersKey = JSON.stringify(filters);

  // "Carregant..." només quan canvien els filtres; un refetch (marcar una
  // línia) refresca les xifres sense amagar la taula ni les files obertes.
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (filtersKey !== prevFiltersKey) {
    setPrevFiltersKey(filtersKey);
    setIsLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .get<PanellObradorAcumulatApi>('/panells/obrador/acumulat', filters)
      .then((resposta) => {
        if (!cancelled) {
          setData(resposta.dades);
          setTotals(resposta.totals);
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
  }, [reloadToken, filtersKey]);

  return {
    data,
    totals,
    isLoading,
    error,
    refetch: () => setReloadToken((token) => token + 1),
  };
}
