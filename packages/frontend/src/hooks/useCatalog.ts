'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  obtenirTotesLesPagines,
  paginacioTaulaCompleta,
  type Paginacio,
  type ProducteApi,
  type RespostaPaginada,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';

export type ProductFormValues = {
  codi: string | null;
  descripcio: string;
  descripcioVenda: string | null;
  categoriaId: number | null;
  agrupacioProduccio: string | null;
  format: ProducteApi['format'];
  envasat: ProducteApi['envasat'];
  pesKg: string | null;
  preuVenda: string | null;
  actiu: boolean;
};

export type CatalogFilters = { cerca?: string };

/**
 * `mida` per defecte es manté a 200 (no 20): `useCatalog()` es fa servir
 * com a taula de consulta completa en 7 llocs fora de la seva pròpia
 * pantalla (workshop, packaging, production, orders/new, orders/[id],
 * PigYieldFormModal, rates/page.tsx — aquest últim el necessita per
 * resoldre categoria/format de CADA producte de la matriu de tarifes, no
 * només els 20 de la pàgina actual). Sols `app/catalog/page.tsx` passa
 * `mida: MIDA_PAGINA_LLISTATS` explícit per paginar de veritat la seva pròpia llista.
 *
 * BUG real corregit (2026-09): amb catàleg real (353 productes), "sense
 * `mida`" no volia dir "tots" — el backend té un topall dur de 200 files
 * per petició (MIDA_PAGINA_MAXIMA, comu.ts), així que els 7 llocs de dalt
 * es quedaven en silenci amb només les primeres 200. Quan `params.mida` no
 * es passa, l'efecte de sota demana totes les pàgines i les combina (ver
 * `obtenirTotesLesPagines`, lib/api.ts) — `app/catalog/page.tsx` (que sí
 * passa `mida: MIDA_PAGINA_LLISTATS`) no entra per aquest camí, segueix paginant una sola
 * pàgina real com sempre.
 */
export type UseCatalogParams = { mida?: number };

type UseCatalogResult = {
  data: ProducteApi[];
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createProduct: (values: ProductFormValues) => Promise<void>;
  editProduct: (id: number, values: ProductFormValues) => Promise<void>;
};

const MIDA_PER_DEFECTE = 200;

export function useCatalog(
  filters: CatalogFilters = {},
  params: UseCatalogParams = {},
): UseCatalogResult {
  // Cal saber-ho ABANS d'aplicar el valor per defecte: "taula completa" és
  // "el caller no ha passat `mida`", no "mida === 200" (algú podria voler
  // 200 de veritat com a pàgina real algun dia).
  const esTaulaCompleta = params.mida === undefined;
  const { mida = MIDA_PER_DEFECTE } = params;
  const [data, setData] = useState<ProducteApi[]>([]);
  const [paginacio, setPaginacio] = useState<Paginacio | null>(null);
  const [pagina, setPagina] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const filtersKey = JSON.stringify(filters);

  // Un canvi de cerca torna a la pàgina 1 — evita quedar-se en una pàgina
  // que ja no existeix pel nou resultat filtrat. Ajustat durant el render
  // (patró oficial de React per "adjusting state when a prop changes":
  // https://react.dev/learn/you-might-not-need-an-effect), no en un
  // efecte — mateix comportament, sense el render intermedi amb la pàgina
  // vella que l'efecte anterior deixava passar abans de corregir-se sol.
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (filtersKey !== prevFiltersKey) {
    setPrevFiltersKey(filtersKey);
    setPagina(1);
  }

  useEffect(() => {
    let cancelled = false;
    // Fetch a un sistema extern (API): el reset síncron d'isLoading/error
    // just abans de cridar-lo és el patró de React per a data fetching en
    // efectes (mateix link de dalt, secció "Fetching data"), no un valor
    // derivable durant el render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    const demanarPagina = (paginaADemanar: number) =>
      api.get<RespostaPaginada<ProducteApi>>('/productes', {
        mida,
        pagina: paginaADemanar,
        ...filters,
      });

    // Mode "taula completa": totes les pàgines combinades (ver comentari a
    // UseCatalogParams). isLoading es manté a true fins que TOTES han
    // arribat — `obtenirTotesLesPagines` no resol fins tenir-les totes.
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
  // completa" (`esTaulaCompleta`): `paginacio` hi és sintètic
  // (`paginacioTaulaCompleta`, sempre pagina=1/totalPagines=1), mai pot
  // quedar fora de rang de veritat.
  usePageClamp(paginacio, setPagina, !esTaulaCompleta);

  // El backend espera categoriaId pla al escriure, no l'objecte categoria
  // que sí retorna el GET (productes.ts) — es tradueix acá, no al formulari.
  function aCosApi(values: ProductFormValues) {
    return {
      codi: values.codi,
      descripcio: values.descripcio,
      descripcioVenda: values.descripcioVenda,
      categoriaId: values.categoriaId,
      agrupacioProduccio: values.agrupacioProduccio,
      format: values.format,
      envasat: values.envasat,
      pesKg: values.pesKg,
      preuVenda: values.preuVenda,
      actiu: values.actiu,
    };
  }

  // Sin edición optimista, mismo criterio que useCategories.ts: refetch tras mutación.
  const createProduct = useCallback(
    async (values: ProductFormValues) => {
      await api.post<ProducteApi>('/productes', aCosApi(values));
      refetch();
    },
    [refetch],
  );

  const editProduct = useCallback(
    async (id: number, values: ProductFormValues) => {
      await api.patch<ProducteApi>(`/productes/${id}`, aCosApi(values));
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
    createProduct,
    editProduct,
  };
}
