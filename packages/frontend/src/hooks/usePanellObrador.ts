'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type FilaPanellObradorApi,
  type Paginacio,
  type PanellObradorApi,
  type TotalsPanellObradorApi,
  type TreballLiniaRespostaApi,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

/**
 * Filtres reals de GET /panells/obrador (contrato §4.7, confirmat contra
 * panells.ts). categoriaId: tasca 24 (01/10/2026). `tipus` existeix al
 * backend però no forma part del disseny d'aquesta pantalla.
 */
export type WorkshopPanelFilters = {
  categoriaId?: number;
  /** Tasca 25. */
  clientId?: number;
  /** Tasca 28: una o més agrupacions de producció (OR). */
  agrupacioProduccio?: string[];
  /** Tasca 31: amb / sense observacions de producció de la línia. */
  observacions?: 'si' | 'no';
  /** Tasca 26: línies pendents o ja fetes. Sense valor = totes. */
  treball?: 'pendents' | 'fets';
  /** Un o més productes (descripció exacta); el backend en fa un OR. */
  producte?: string[];
  /** Tasca 29: les línies d'un sol producte (desplegar la vista acumulada). */
  producteId?: number;
  format?: string;
  envasat?: string;
  dataProduccioDes?: string;
  dataProduccioFins?: string;
};

/** Tasca 26: resultat de POST /panells/obrador/marcar-fets. */
export type MarcarTotesResult =
  { success: true; marcades: number; congeladesOmeses: number } | { success: false; error: string };

/** `PATCH .../treball`. El 409 (comanda congelada) no porta `detalls` per camp, mateix criteri que `LliuramentSaveResult`. */
export type ToggleTreballResult = { success: true } | { success: false; error: string };

/**
 * Issue del reordenament immediat — replica DELIBERADAMENT el mateix
 * ORDER BY de `GET /panells/obrador` (panells.ts:349): `(treballat_a IS
 * NOT NULL) ASC, data_produccio ASC NULLS LAST, num ASC, ordinal ASC`. Si
 * algú canvia aquell ORDER BY en el futur, aquest comparador s'ha
 * d'actualitzar igual.
 *
 * Incompleta A PROPÒSIT: `num` (comanda) i `ordinal` (línia) NOMÉS es fan
 * servir al ORDER BY del backend, mai es seleccionen ni viatgen a
 * `FilaPanellObradorApi` (confirmat contra el SELECT real de panells.ts) —
 * no hi ha manera d'aplicar-los acá sense afegir camps nous al contracte,
 * fora de l'abast d'aquest canvi. En comptes d'això, ens recolzem en que
 * `Array.prototype.sort` és estable (garantit des d'ES2019): quan dues
 * files empaten en `treballatA`/`dataProduccio`, mantenen l'ordre relatiu
 * que ja tenien a `current` — que, per a qualsevol fila que no s'acaba de
 * tocar, ja reflecteix el num/ordinal real del darrer fetch complet. Només
 * la fila que s'acaba de marcar/desmarcar pot quedar mal ordenada DINS
 * d'un empat exacte (mateix treballatA i mateixa dataProduccio) amb altres
 * files — un cas marginal, no el problema real que es reporta.
 */
function compararOrdreObrador(a: FilaPanellObradorApi, b: FilaPanellObradorApi): number {
  const aTreballada = a.treballatA !== null;
  const bTreballada = b.treballatA !== null;
  if (aTreballada !== bTreballada) return aTreballada ? 1 : -1;

  if (a.dataProduccio === null && b.dataProduccio === null) return 0;
  if (a.dataProduccio === null) return 1; // NULLS LAST
  if (b.dataProduccio === null) return -1;
  if (a.dataProduccio < b.dataProduccio) return -1;
  if (a.dataProduccio > b.dataProduccio) return 1;
  return 0;
}

type UsePanellObradorResult = {
  data: FilaPanellObradorApi[];
  totals: TotalsPanellObradorApi | null;
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  toggleTreball: (
    comandaId: number,
    liniaId: number,
    marcat: boolean,
  ) => Promise<ToggleTreballResult>;
  marcarTotesFetes: () => Promise<MarcarTotesResult>;
};

// Paginació real (MIDA_PAGINA_LLISTATS/pàgina). `totals` ve calculat pel backend sobre TOT
// el filtrat (no només `dades`, que sí pagina de veritat) — mai es
// recalcula sumant `dades` acá.
const MIDA_PAGINA = MIDA_PAGINA_LLISTATS;

export function usePanellObrador(filters: WorkshopPanelFilters = {}): UsePanellObradorResult {
  const [data, setData] = useState<FilaPanellObradorApi[]>([]);
  const [totals, setTotals] = useState<TotalsPanellObradorApi | null>(null);
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
      .get<PanellObradorApi>('/panells/obrador', { mida: MIDA_PAGINA, pagina, ...filters })
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

  // No refetegeix la llista sencera en èxit (a diferència de
  // saveLliurament a usePanellEmpaquetat.ts): la resposta del PATCH ja porta
  // el valor real (releguit de la base, no ecoat), n'hi ha prou amb pegar
  // aquesta línia dins `data` — evita el flaix de "carregant..." per un sol
  // click de checkbox.
  const toggleTreball = useCallback(
    async (comandaId: number, liniaId: number, marcat: boolean): Promise<ToggleTreballResult> => {
      try {
        const resposta = await api.patch<TreballLiniaRespostaApi>(
          `/comandes/${comandaId}/linies/${liniaId}/treball`,
          { marcat },
        );
        const abans = data.find((line) => line.liniaId === liniaId);
        setData((current) =>
          current
            .map((line) =>
              line.liniaId === liniaId
                ? { ...line, treballatA: resposta.treballatA, treballatPer: resposta.treballatPer }
                : line,
            )
            .sort(compararOrdreObrador),
        );
        // Tasca 26: sense refetch, els comptadors de fetes/pendents
        // s'ajusten aquí perquè no quedin desfasats.
        const eraFeta = abans ? abans.treballatA !== null : !marcat;
        const araFeta = resposta.treballatA !== null;
        if (eraFeta !== araFeta) {
          const delta = araFeta ? 1 : -1;
          setTotals((current) =>
            current
              ? {
                  ...current,
                  liniesFetes: current.liniesFetes + delta,
                  liniesPendents: current.liniesPendents - delta,
                }
              : current,
          );
        }
        return { success: true };
      } catch (caught) {
        const error = caught instanceof ApiError ? caught.message : "No s'ha pogut actualitzar.";
        return { success: false, error };
      }
    },
    [data],
  );

  // Tasca 26: marca com a fetes totes les línies pendents que compleixen
  // els filtres actius (el backend aplica els mateixos filtres, no només la
  // pàgina visible) i torna a carregar la llista.
  const marcarTotesFetes = useCallback(async (): Promise<MarcarTotesResult> => {
    try {
      // `treball` no aplica: l'acció ja només toca les pendents.
      const filtresAccio = { ...filters };
      delete filtresAccio.treball;
      const resposta = await api.post<{ marcades: number; congeladesOmeses: number }>(
        '/panells/obrador/marcar-fets',
        {},
        filtresAccio,
      );
      setReloadToken((token) => token + 1);
      return { success: true, ...resposta };
    } catch (caught) {
      const error = caught instanceof ApiError ? caught.message : "No s'han pogut marcar.";
      return { success: false, error };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  return {
    data,
    totals,
    paginacio,
    pagina,
    setPagina,
    isLoading,
    error,
    refetch,
    toggleTreball,
    marcarTotesFetes,
  };
}
