'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Paginacio,
  type RendimentPorcApi,
  type RendimentPorcEntradaApi,
  type RespostaPaginada,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

export type PigYieldPatch = Partial<Pick<RendimentPorcApi, 'unitatsPerPorc' | 'kgPerUnitat'>>;

export type PigYieldFilters = {
  categoria?: string;
};

type UsePigYieldsResult = {
  data: RendimentPorcApi[];
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createPigYield: (values: RendimentPorcEntradaApi) => Promise<void>;
  updatePigYield: (id: number, patch: PigYieldPatch) => Promise<void>;
  deletePigYield: (id: number) => Promise<void>;
};

const MIDA_PAGINA = MIDA_PAGINA_LLISTATS;

export function usePigYields(filters: PigYieldFilters = {}): UsePigYieldsResult {
  const [data, setData] = useState<RendimentPorcApi[]>([]);
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
      .get<RespostaPaginada<RendimentPorcApi>>('/rendiments-porcs', {
        mida: MIDA_PAGINA,
        pagina,
        ...filters,
      })
      .then((resposta) => {
        if (!cancelled) {
          setData(resposta.dades);
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

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  // Hallazgo A (auditoria de paginació) — corregeix `pagina` si borrar un
  // rendiment deixa l'usuari en una pàgina que ja no existeix.
  usePageClamp(paginacio, setPagina);

  // Sin edición optimista, mismo criterio que useCategories.ts/useCatalog.ts:
  // refetch tras mutación. Issues #3/#4 (migració 0018): categoriaId +
  // agrupacioProduccio identifiquen la fila i SÍ viatgen en aquest POST —
  // ja no hi ha producteId del qual derivar-los. agrupacioRendiment/
  // categoria (nom) segueixen sent només de lectura.
  const createPigYield = useCallback(
    async (entrada: RendimentPorcEntradaApi) => {
      await api.post<RendimentPorcApi>('/rendiments-porcs', entrada);
      refetch();
    },
    [refetch],
  );

  // categoriaId/agrupacioProduccio no formen part del payload de PATCH (el
  // backend no els accepta, confirmat: la identitat d'una fila és fixa un
  // cop creada — mateix criteri que producteId abans de la migració 0018).
  const updatePigYield = useCallback(
    async (id: number, patch: PigYieldPatch) => {
      await api.patch<RendimentPorcApi>(`/rendiments-porcs/${id}`, patch);
      refetch();
    },
    [refetch],
  );

  const deletePigYield = useCallback(
    async (id: number) => {
      await api.delete(`/rendiments-porcs/${id}`);
      refetch();
    },
    [refetch],
  );

  return {
    data,
    paginacio,
    pagina,
    setPagina,
    isLoading,
    error,
    refetch,
    createPigYield,
    updatePigYield,
    deletePigYield,
  };
}
