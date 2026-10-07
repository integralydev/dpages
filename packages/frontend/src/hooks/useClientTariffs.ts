'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  obtenirTotesLesPagines,
  paginacioTaulaCompleta,
  type ClientApi,
  type Paginacio,
  type RespostaPaginada,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';

export type ClientFormValues = {
  nom: string;
  poblacio: string;
  tarifaId: number | null;
  nif: string | null;
  email: string | null;
  telefon: string | null;
};

export type ClientTariffsFilters = { cerca?: string };

/**
 * `mida` per defecte es manté a 200 (no 20): `useClientTariffs()` es fa
 * servir com a taula de consulta completa en 5 llocs fora de la seva
 * pròpia pantalla (packaging, office, orders/page, orders/new, orders/[id])
 * per resoldre nom/codi de client — necessiten TOTS els clients, no una
 * pàgina. Només `app/client-tariffs/page.tsx` passa `mida: MIDA_PAGINA_LLISTATS`
 * explícit per paginar de veritat la seva pròpia llista.
 *
 * BUG real corregit: amb 1291 clients reals, "sense `mida`" no
 * volia dir "tots" — el backend té un topall dur de 200 files per petició
 * (MIDA_PAGINA_MAXIMA, comu.ts), així que els 5 llocs de dalt es quedaven
 * en silenci amb només els primers 200. Quan `params.mida` no es passa,
 * l'efecte de sota demana totes les pàgines i les combina (ver
 * `obtenirTotesLesPagines`, lib/api.ts) — `app/client-tariffs/page.tsx`
 * (que sí passa `mida: MIDA_PAGINA_LLISTATS`) no entra per aquest camí, segueix paginant una
 * sola pàgina real com sempre.
 */
export type UseClientTariffsParams = { mida?: number };

type UseClientTariffsResult = {
  data: ClientApi[];
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createClient: (values: ClientFormValues) => Promise<void>;
  editClient: (id: number, values: ClientFormValues) => Promise<void>;
};

const MIDA_PER_DEFECTE = 200;

export function useClientTariffs(
  filters: ClientTariffsFilters = {},
  params: UseClientTariffsParams = {},
): UseClientTariffsResult {
  // Cal saber-ho ABANS d'aplicar el valor per defecte: "taula completa" és
  // "el caller no ha passat `mida`", no "mida === 200".
  const esTaulaCompleta = params.mida === undefined;
  const { mida = MIDA_PER_DEFECTE } = params;
  const [data, setData] = useState<ClientApi[]>([]);
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

    const demanarPagina = (paginaADemanar: number) =>
      api.get<RespostaPaginada<ClientApi>>('/clients', {
        mida,
        pagina: paginaADemanar,
        ...filters,
      });

    // Mode "taula completa": totes les pàgines combinades (ver comentari a
    // UseClientTariffsParams). isLoading es manté a true fins que TOTES han
    // arribat.
    const carrega = esTaulaCompleta
      ? obtenirTotesLesPagines(demanarPagina).then((dades) => ({
          dades,
          paginacio: paginacioTaulaCompleta(dades.length),
        }))
      : demanarPagina(pagina);

    carrega
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
  }, [reloadToken, pagina, mida, filtersKey, esTaulaCompleta]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  // Hallazgo A (auditoria de paginació) — desactivat al mode "taula
  // completa" (`esTaulaCompleta`), mateix criteri que useCatalog.ts.
  usePageClamp(paginacio, setPagina, !esTaulaCompleta);

  const createClient = useCallback(
    async (values: ClientFormValues) => {
      // codi no se manda: el backend lo autogenera siempre, lo ignoraría
      // igual si viajara. POST /clients tampoco acepta
      // tarifaId: null (sólo PATCH tiene esa rama) — confirmado con curl
      // real: mandarlo explícito da un 400 falso ("la tarifa no existeix").
      // "Sense tarifa" en alta = directamente omitir la clave, no mandarla
      // en null.
      const cos: Record<string, unknown> = {
        nom: values.nom,
        poblacio: values.poblacio,
        nif: values.nif,
        email: values.email,
        telefon: values.telefon,
      };
      if (values.tarifaId !== null) cos.tarifaId = values.tarifaId;
      await api.post<ClientApi>('/clients', cos);
      refetch();
    },
    [refetch],
  );

  const editClient = useCallback(
    async (id: number, values: ClientFormValues) => {
      // codi no se manda: es de sólo lectura para siempre, el backend lo
      // ignoraría igual (ver PATCH /clients/:id). transportistaDefecteId
      // tampoco se manda: esta pantalla no lo toca.
      await api.patch<ClientApi>(`/clients/${id}`, {
        nom: values.nom,
        poblacio: values.poblacio,
        nif: values.nif,
        email: values.email,
        telefon: values.telefon,
        tarifaId: values.tarifaId,
      });
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
    createClient,
    editClient,
  };
}
