'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Paginacio, type RolApi } from '@/lib/api';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

export type CreateRoleInput = { nom: string; modulsPermesos: string[] };
export type EditRoleInput = Partial<{ nom: string; modulsPermesos: string[] }>;

type UseRolsResult = {
  data: RolApi[];
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createRole: (input: CreateRoleInput) => Promise<RolApi>;
  editRole: (id: number, input: EditRoleInput) => Promise<RolApi>;
};

// GET /rols ya pagina de verdad (mismo shape que el resto,
// confirmado contra rols.ts: parsearPaginacio/construirPaginacio). No hi ha
// DELETE /rols — aquest hook no en té cap funció equivalent, la UI tampoc
// ofereix l'acció.
const MIDA_PAGINA = MIDA_PAGINA_LLISTATS;

export function useRols(): UseRolsResult {
  const [data, setData] = useState<RolApi[]>([]);
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
      .get<{ dades: RolApi[]; paginacio: Paginacio }>('/rols', { mida: MIDA_PAGINA, pagina })
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
  }, [reloadToken, pagina]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  const createRole = useCallback(
    async (input: CreateRoleInput): Promise<RolApi> => {
      const resposta = await api.post<RolApi>('/rols', input);
      refetch();
      return resposta;
    },
    [refetch],
  );

  const editRole = useCallback(
    async (id: number, input: EditRoleInput): Promise<RolApi> => {
      const resposta = await api.patch<RolApi>(`/rols/${id}`, input);
      refetch();
      return resposta;
    },
    [refetch],
  );

  return { data, paginacio, pagina, setPagina, isLoading, error, refetch, createRole, editRole };
}
