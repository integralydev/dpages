'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  obtenirTotesLesPagines,
  type ProveidorApi,
  type RespostaPaginada,
} from '@/lib/api';

export type ProveidorFormValues = { nom: string };

type UseProveidorsResult = {
  data: ProveidorApi[];
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createProveidor: (values: ProveidorFormValues) => Promise<void>;
  editProveidor: (id: number, values: ProveidorFormValues) => Promise<void>;
  deleteProveidor: (id: number) => Promise<void>;
};

/**
 * Punt 55 (18/11/2026): tots els proveïdors (sense paginar: n'hi haurà
 * pocs). Els fan servir el seu manteniment, la fitxa de l'article, les
 * línies de comanda i el filtre del Panell Obrador.
 */
export function useProveidors(): UseProveidorsResult {
  const [data, setData] = useState<ProveidorApi[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Fetch a un sistema extern (API): mateix patró que la resta de hooks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    obtenirTotesLesPagines((pagina) =>
      api.get<RespostaPaginada<ProveidorApi>>('/proveidors', { mida: 200, pagina }),
    )
      .then((dades) => {
        if (!cancelled) setData(dades);
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
  }, [reloadToken]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  const createProveidor = useCallback(
    async (values: ProveidorFormValues) => {
      await api.post<ProveidorApi>('/proveidors', values);
      refetch();
    },
    [refetch],
  );

  const editProveidor = useCallback(
    async (id: number, values: ProveidorFormValues) => {
      await api.patch<ProveidorApi>(`/proveidors/${id}`, values);
      refetch();
    },
    [refetch],
  );

  const deleteProveidor = useCallback(
    async (id: number) => {
      await api.delete<void>(`/proveidors/${id}`);
      refetch();
    },
    [refetch],
  );

  return { data, isLoading, error, refetch, createProveidor, editProveidor, deleteProveidor };
}
