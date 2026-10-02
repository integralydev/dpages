'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CategoriaApi, type Paginacio, type RespostaPaginada } from '@/lib/api';
import { usePageClamp } from './usePageClamp';

export type CategoryFormValues = Pick<CategoriaApi, 'nom' | 'elaboratPorc' | 'agrupacioRendiment'>;

/**
 * `mida` per defecte es manté a 200 (no 20): aquest hook no només alimenta
 * la seva pròpia pantalla (Categories, que sí pagina de veritat passant
 * `mida: MIDA_PAGINA_LLISTATS` explícit) — `ProductForm.tsx`/`PigYieldFormModal.tsx`/
 * `pig-yields/page.tsx` el fan servir com a taula de consulta completa per
 * resoldre noms de categoria, i necessiten TOTES les files, no una pàgina.
 * Canviar el valor per defecte trencaria aquests 3 llocs en silenci.
 */
export type UseCategoriesParams = { mida?: number };

type UseCategoriesResult = {
  data: CategoriaApi[];
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createCategory: (values: CategoryFormValues) => Promise<void>;
  editCategory: (id: number, values: CategoryFormValues) => Promise<void>;
  deleteCategory: (id: number) => Promise<void>;
};

const MIDA_PER_DEFECTE = 200;

export function useCategories(params: UseCategoriesParams = {}): UseCategoriesResult {
  const { mida = MIDA_PER_DEFECTE } = params;
  const [data, setData] = useState<CategoriaApi[]>([]);
  const [paginacio, setPaginacio] = useState<Paginacio | null>(null);
  const [pagina, setPagina] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Fetch a un sistema extern (API): el reset síncron d'isLoading/error
    // just abans de cridar-lo és el patró de React per a data fetching en
    // efectes, no un valor derivable durant el render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    api
      .get<RespostaPaginada<CategoriaApi>>('/categories', { mida, pagina })
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
  }, [reloadToken, pagina, mida]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  // Hallazgo A (auditoria de paginació) — corregeix `pagina` si borrar una
  // categoria deixa l'usuari en una pàgina que ja no existeix.
  usePageClamp(paginacio, setPagina);

  // Sin edición optimista a propósito: el backend devuelve la fila
  // creada/editada, no la lista completa (a diferencia del mock viejo) —
  // más simple y confiable re-pedir la lista que reconstruirla a mano.
  const createCategory = useCallback(
    async (values: CategoryFormValues) => {
      await api.post<CategoriaApi>('/categories', values);
      refetch();
    },
    [refetch],
  );

  const editCategory = useCallback(
    async (id: number, values: CategoryFormValues) => {
      await api.patch<CategoriaApi>(`/categories/${id}`, values);
      refetch();
    },
    [refetch],
  );

  const deleteCategory = useCallback(
    async (id: number) => {
      await api.delete(`/categories/${id}`);
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
    createCategory,
    editCategory,
    deleteCategory,
  };
}
