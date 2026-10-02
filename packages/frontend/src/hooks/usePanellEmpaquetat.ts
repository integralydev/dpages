'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type FilaPanellEmpaquetatApi,
  type LliuramentBodyApi,
  type Paginacio,
  type PanellEmpaquetatApi,
  type TotalsPanellEmpaquetatApi,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

/**
 * Els filtres reals de GET /panells/empaquetat (confirmat contra
 * panells.ts) — dataLliuramentDes/Fins i producte abans no tenien suport
 * al backend. categoriaId i confirmacio: peticions d'Ari (29/09/2026).
 */
export type PackagingPanelFilters = {
  dataExpedicioDes?: string;
  dataExpedicioFins?: string;
  /** Un o més transportistes (tasca 22); el backend en fa un OR. */
  transportistaId?: number[];
  clientId?: number;
  dataLliuramentDes?: string;
  dataLliuramentFins?: string;
  /** Un o més productes (descripció exacta); el backend en fa un OR. */
  producte?: string[];
  categoriaId?: number;
  /** Sense valor = totes les línies. */
  confirmacio?: 'pendents' | 'confirmades';
};

/**
 * unitatsLliurades/kgLliurats (400, VALIDACIO) arriben amb `detalls` per
 * camp; el 409 CONFLICTE (comanda congelada) no en porta cap — es
 * distingeix acá perquè la fila mostri cadascun on correspon.
 */
export type LliuramentSaveResult =
  | { success: true }
  | { success: false; fieldErrors: Record<string, string>; generalError: string | null };

type UsePanellEmpaquetatResult = {
  data: FilaPanellEmpaquetatApi[];
  totals: TotalsPanellEmpaquetatApi | null;
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  saveLliurament: (
    comandaId: number,
    liniaId: number,
    body: LliuramentBodyApi,
  ) => Promise<LliuramentSaveResult>;
  /** Issue #19 — desfer una línia ja confirmada: reseteja confirmatA/confirmatPer, mai toca unitats/kg. */
  undoLliurament: (comandaId: number, liniaId: number) => Promise<LliuramentSaveResult>;
};

// Paginació real (MIDA_PAGINA_LLISTATS/pàgina), mateix criteri que usePanellOficina.ts/usePanellObrador.ts.
const MIDA_PAGINA = MIDA_PAGINA_LLISTATS;

export function usePanellEmpaquetat(
  filters: PackagingPanelFilters = {},
): UsePanellEmpaquetatResult {
  const [data, setData] = useState<FilaPanellEmpaquetatApi[]>([]);
  const [totals, setTotals] = useState<TotalsPanellEmpaquetatApi | null>(null);
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
      .get<PanellEmpaquetatApi>('/panells/empaquetat', { mida: MIDA_PAGINA, pagina, ...filters })
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

  const saveLliurament = useCallback(
    async (
      comandaId: number,
      liniaId: number,
      body: LliuramentBodyApi,
    ): Promise<LliuramentSaveResult> => {
      try {
        await api.patch(`/comandes/${comandaId}/linies/${liniaId}/lliurament`, body);
        refetch();
        return { success: true };
      } catch (caught) {
        if (caught instanceof ApiError) {
          const fieldErrors: Record<string, string> = {};
          for (const detall of caught.detalls ?? []) fieldErrors[detall.camp] = detall.missatge;
          return {
            success: false,
            fieldErrors,
            generalError: (caught.detalls?.length ?? 0) > 0 ? null : caught.message,
          };
        }
        return { success: false, fieldErrors: {}, generalError: 'Error desconegut.' };
      }
    },
    [],
  );

  // Issue #19 — sense body: desfer sempre és la mateixa operació. Reutilitza
  // LliuramentSaveResult (fieldErrors sempre buit acá, no hi ha cap camp a
  // validar) per no afegir un tipus de resultat nou només per aquest cas.
  const undoLliurament = useCallback(
    async (comandaId: number, liniaId: number): Promise<LliuramentSaveResult> => {
      try {
        await api.patch(`/comandes/${comandaId}/linies/${liniaId}/lliurament/desfer`);
        refetch();
        return { success: true };
      } catch (caught) {
        const generalError = caught instanceof ApiError ? caught.message : 'Error desconegut.';
        return { success: false, fieldErrors: {}, generalError };
      }
    },
    [],
  );

  return {
    data,
    totals,
    paginacio,
    pagina,
    setPagina,
    isLoading,
    error,
    refetch,
    saveLliurament,
    undoLliurament,
  };
}
