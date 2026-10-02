'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Paginacio,
  type RespostaPaginada,
  type UsuariApi,
  type UsuariCreatRespostaApi,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

export type UserFilters = {
  actiu?: boolean;
  /** Issue #17 — substring (ILIKE) sobre nom O email, confirmat contra usuaris.ts. */
  cerca?: string;
};

export type CreateUserInput = { nom: string; email: string; rolId: number };
export type EditUserInput = Partial<{ nom: string; rolId: number; actiu: boolean }>;

type UseUsersResult = {
  data: UsuariApi[];
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createUser: (input: CreateUserInput) => Promise<UsuariCreatRespostaApi>;
  editUser: (id: number, input: EditUserInput) => Promise<UsuariApi>;
};

// Paginació real (MIDA_PAGINA_LLISTATS/pàgina).
const MIDA_PAGINA = MIDA_PAGINA_LLISTATS;

export function useUsers(filters: UserFilters = {}): UseUsersResult {
  const [data, setData] = useState<UsuariApi[]>([]);
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
      .get<RespostaPaginada<UsuariApi>>('/usuaris', { mida: MIDA_PAGINA, pagina, ...filters })
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

  // Hallazgo A (auditoria de paginació) — corregeix `pagina` si un canvi
  // deixa l'usuari en una pàgina que ja no existeix.
  usePageClamp(paginacio, setPagina);

  // Els 400 (camp/email) i 409 (email duplicat) los mapea directament el
  // formulario que llama a createUser/editUser, capturando ApiError — mismo
  // criteri que ProductForm.tsx/PigYieldFormModal.tsx, sin envoltori acá.
  const createUser = useCallback(
    async (input: CreateUserInput): Promise<UsuariCreatRespostaApi> => {
      const resposta = await api.post<UsuariCreatRespostaApi>('/usuaris', input);
      refetch();
      return resposta;
    },
    [refetch],
  );

  const editUser = useCallback(
    async (id: number, input: EditUserInput): Promise<UsuariApi> => {
      const resposta = await api.patch<UsuariApi>(`/usuaris/${id}`, input);
      refetch();
      return resposta;
    },
    [refetch],
  );

  return { data, paginacio, pagina, setPagina, isLoading, error, refetch, createUser, editUser };
}
