'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ComandaCreacioApi,
  type ComandaDetallApi,
  type ComandaResumApi,
  type LiniaCreacioApi,
  type LiniaEdicioApi,
  type Paginacio,
  type RespostaPaginada,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

export type OrderListFilters = {
  estat?: string;
  /** `OrigenComandaApi.codi` (GET /comandes?origen=, coincidència exacta). */
  origen?: string;
  dataDes?: string;
  dataFins?: string;
  dataProduccioDes?: string;
  dataProduccioFins?: string;
  dataLliuramentDes?: string;
  dataLliuramentFins?: string;
  cerca?: string;
};

export type OrderFormValues = {
  clientId: number | null;
  /**
   * `OrigenComandaApi.codi`. En creación, obligatorio (OrderForm.tsx valida
   * que no sea `null` antes de llamar a `onSave`) — `createOrder` lo manda
   * siempre.
   *
   * En edición, `PATCH /comandes/:id` SÍ acepta `origen` (nueva
   * funcionalidad): sólo hacia uno de los 3 canales manuales
   * (whatsapp/telefon/correu), nunca "woocommerce" — el backend rechaza con
   * 400 cualquier otro código. Si el pedido ya es de WooCommerce, su
   * origen no se puede cambiar (tarea 11).
   * `null` en este campo significa "el usuario no tocó el origen" — mismo
   * criterio que `tariffTouched`/`poblacioTouched` en OrderForm.tsx:
   * `editOrder` (más abajo) sólo incluye `origen` en el PATCH cuando viene
   * distinto de `null`, para no reenviar por accidente el valor actual de
   * un pedido en "woocommerce"/"manual" (que el backend rechazaría aunque
   * el usuario no haya querido cambiar nada).
   */
  origen: string | null;
  /**
   * `POST /comandes` acepta `tarifaId` directo (createOrder, más
   * abajo). En edición viaja igual en el PATCH.
   */
  tarifaId: number | null;
  transportistaId: number | null;
  /**
   * Issue #16 — nova, OBLIGATÒRIA als dos modes (POST i PATCH la rebutgen
   * buida). Mai `null` a diferència de les altres 3 dates: OrderForm.tsx
   * bloqueja el submit abans si estigués buida.
   */
  dataComanda: string;
  /**
   * Data de producció de CAPÇALERA (tasca 15, 01/10/2026). Revertix la
   * fusió anterior que l'enviava sempre igual a `dataComanda`: torna a ser
   * un camp propi del formulari, que s'aplica per defecte a les línies
   * (OrderForm.tsx) i fa de mínim de les seves dates (regla 4 del backend).
   * `null` = sense data de producció de capçalera.
   */
  dataProduccio: string | null;
  dataExpedicio: string | null;
  dataLliurament: string | null;
  bultos: number | null;
  obsProduccio: string | null;
  obsLliurament: string | null;
  poblacioDesti: string | null;
  adrecaLliurament: string | null;
  /**
   * `PATCH /comandes/:id` acepta `estat`, con transición libre
   * entre `oberta`/`en_proces`/`tancada`/`cancellada`. El único camino hacia
   * `amb_incidencia` es `markIncidence` (más abajo, exige `detall`) — este
   * valor nunca se manda como `"amb_incidencia"` desde `editOrder` (ver
   * OrderForm.tsx: el selector de capçalera no ofrece esa opción).
   */
  estat: string;
  /** Sólo se usa en creación — el POST se arma con esto. */
  linies: LiniaCreacioApi[];
};

/** Línies noves (POST) i línies editades (PATCH) d'una comanda ja creada. Buit en mode "create" (les línies viatgen dins ComandaCreacioApi). */
export type OrderLineChanges = {
  novaLinies: LiniaCreacioApi[];
  liniesEditades: { liniaId: number; patch: LiniaEdicioApi }[];
};

/**
 * El 400 de coherència de dates (POST /comandes, PATCH
 * /comandes/:id, i els dos endpoints de línia) ve amb `missatge` genèric
 * al nivell superior ("Les dates no són coherents") i el detall REAL
 * (quina regla, i per a les línies, quina línia — "línia núm. 38008: ...")
 * dins `detalls[0].missatge`. Sempre és NOMÉS el primer detall (el
 * backend no acumula els 7); el seu `camp` és `dataComanda` (regla 7,
 * issue #16)/`dataLliurament`/`dataExpedicio` (capçalera) o el sintètic
 * `linies[].dataProduccio` — cap coincideix amb el patró de mapeig per
 * camp que fem servir a altres pantalles (ex. ClientFormModal), i el de
 * línia ni tan sols apunta a cap input real. Per això NO s'intenta
 * mapejar: es mostra el missatge sencer (genèric + detall) com a error
 * de formulari.
 */
function esErrorCoherenciaDates(caught: ApiError): boolean {
  const camp = caught.detalls?.[0]?.camp;
  return (
    caught.codi === 'VALIDACIO' &&
    (camp === 'dataComanda' ||
      camp === 'dataLliurament' ||
      camp === 'dataExpedicio' ||
      (camp?.startsWith('linies[') ?? false))
  );
}

export function extractComandaErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    if (esErrorCoherenciaDates(caught)) {
      return `${caught.message}: ${caught.detalls![0]!.missatge}`;
    }
    return caught.message;
  }
  return fallback;
}

type UseOrdersResult = {
  data: ComandaResumApi[];
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createOrder: (
    values: OrderFormValues,
  ) => Promise<{ order: ComandaDetallApi; patchError: ApiError | null }>;
  editOrder: (id: number, values: OrderFormValues) => Promise<void>;
  deleteLine: (comandaId: number, liniaId: number) => Promise<void>;
  /** PATCH { estat: "amb_incidencia", detall }. `detall` és obligatori (400 si arriba buit). */
  markIncidence: (comandaId: number, detall: string) => Promise<ComandaDetallApi>;
  /** POST /comandes/:comandaId/linies. */
  addLine: (comandaId: number, linia: LiniaCreacioApi) => Promise<ComandaDetallApi>;
  /** PATCH /comandes/:comandaId/linies/:liniaId. */
  editLine: (
    comandaId: number,
    liniaId: number,
    patch: LiniaEdicioApi,
  ) => Promise<ComandaDetallApi>;
};

// Paginació real (MIDA_PAGINA_LLISTATS/pàgina) — a diferència de catálogos/categorías/
// tarifas, el volumen de comandas crece cada semana, así que ya se
// filtraba server-side (los filtros de la pantalla tienen soporte real en
// GET /comandes); ahora también pagina de verdad en vez de traer 200.
const MIDA_PAGINA = MIDA_PAGINA_LLISTATS;

export function useOrders(filters: OrderListFilters = {}): UseOrdersResult {
  const [data, setData] = useState<ComandaResumApi[]>([]);
  const [paginacio, setPaginacio] = useState<Paginacio | null>(null);
  const [pagina, setPagina] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const filtersKey = JSON.stringify(filters);

  // Un canvi de filtre torna a la pàgina 1 — evita quedar-se en una pàgina
  // que ja no existeix pel nou resultat filtrat. Ajustat durant el render
  // (patró oficial de React per "adjusting state when a prop changes":
  // https://react.dev/learn/you-might-not-need-an-effect), no en un
  // efecte — mateix comportament, sense el render intermedi amb la pàgina
  // vella.
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
      .get<RespostaPaginada<ComandaResumApi>>('/comandes', {
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
    // filtersKey serialitza `filters` (objecte pla de primitives) — evita
    // refer la petició en cada render per canvi d'identitat de l'objecte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, pagina, filtersKey]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  // Hallazgo A (auditoria de paginació) — corregeix `pagina` si un canvi
  // deixa l'usuari en una pàgina que ja no existeix.
  usePageClamp(paginacio, setPagina);

  // Alta real (POST) + PATCH encadenado para los campos que POST no acepta
  // (bultos/poblacioDesti/adrecaLliurament/obsProduccio/dataProduccio/
  // dataExpedicio — fuera de ComandaCreacioApi, contrato §4.5). tarifaId
  // SÍ viaja directo en el POST, igual que dataComanda/dataLliurament
  // desde issue #16 (antes esta última era opcional y podía
  // ir en cualquiera de los dos, ahora viaja siempre en el POST). Si el POST
  // tiene éxito pero el PATCH falla, la comanda YA existe — nunca se
  // reintenta el POST (evitaría duplicados); se devuelve la comanda creada
  // más el error del PATCH para que la pantalla avise qué campos no se
  // guardaron.
  const createOrder = useCallback(
    async (values: OrderFormValues) => {
      // OrderForm.tsx ya valida que `origen` no sea null antes de
      // llegar acá (mode create); el "manual" de reserva nunca debería
      // disparar en la práctica, sólo defensivo.
      // Issue #16 — dataComanda/dataLliurament passen a viatjar sempre
      // (mai condicionals): les dues són ara OBLIGATÒRIES a POST /comandes,
      // OrderForm.tsx ja bloqueja el submit abans si falten. El `!` de
      // dataLliurament reflecteix aquesta garantia (el tipus de
      // OrderFormValues la manté `string | null` perquè en mode edició sí
      // pot ser null).
      const cos: ComandaCreacioApi = {
        origen: values.origen ?? 'manual',
        dataComanda: values.dataComanda,
        dataLliurament: values.dataLliurament!,
        linies: values.linies,
      };
      if (values.clientId !== null) cos.clientId = values.clientId;
      if (values.tarifaId !== null) cos.tarifaId = values.tarifaId;
      if (values.transportistaId !== null) cos.transportistaId = values.transportistaId;
      if (values.obsLliurament !== null) cos.obsLliurament = values.obsLliurament;

      const creada = await api.post<ComandaDetallApi>('/comandes', cos);

      // Tasca 15: `dataProduccio` de capçalera torna a ser un camp propi.
      const patchCos: Record<string, unknown> = {};
      if (values.dataProduccio !== null) patchCos.dataProduccio = values.dataProduccio;
      if (values.bultos !== null) patchCos.bultos = values.bultos;
      if (values.poblacioDesti !== null) patchCos.poblacioDesti = values.poblacioDesti;
      if (values.adrecaLliurament !== null) patchCos.adrecaLliurament = values.adrecaLliurament;
      if (values.obsProduccio !== null) patchCos.obsProduccio = values.obsProduccio;
      if (values.dataExpedicio !== null) patchCos.dataExpedicio = values.dataExpedicio;

      try {
        const actualitzada = await api.patch<ComandaDetallApi>(`/comandes/${creada.id}`, patchCos);
        refetch();
        return { order: actualitzada, patchError: null };
      } catch (caught) {
        refetch();
        return {
          order: creada,
          patchError:
            caught instanceof ApiError
              ? caught
              : new ApiError('ERROR_XARXA', 'Error desconegut.', null),
        };
      }
    },
    [refetch],
  );

  const editOrder = useCallback(
    async (id: number, values: OrderFormValues) => {
      const cos: Record<string, unknown> = {
        clientId: values.clientId,
        tarifaId: values.tarifaId,
        transportistaId: values.transportistaId,
        // Issue #16 — dataComanda és editable després de creada (PATCH la
        // rebutja buida, mai null: OrderFormValues.dataComanda ja és
        // `string`, no cal cap guarda acá).
        dataComanda: values.dataComanda,
        // Tasca 15: camp propi de capçalera (null = buidar-la).
        dataProduccio: values.dataProduccio,
        dataExpedicio: values.dataExpedicio,
        dataLliurament: values.dataLliurament,
        bultos: values.bultos,
        obsProduccio: values.obsProduccio,
        obsLliurament: values.obsLliurament,
        poblacioDesti: values.poblacioDesti,
        adrecaLliurament: values.adrecaLliurament,
      };
      // El selector de capçalera (OrderForm.tsx) només ofereix
      // oberta/en_proces/tancada/cancellada, mai amb_incidencia: si l'estat carregat
      // ja era amb_incidencia i l'usuari no l'ha tocat, NO es reenvia (el
      // backend exigeix `detall` sempre que `estat` sigui amb_incidencia
      // al body, encara que sigui el mateix valor que ja tenia). La única
      // via cap a amb_incidencia és markIncidence, més avall.
      if (values.estat !== 'amb_incidencia') {
        cos.estat = values.estat;
      }
      // `null` = l'usuari no ha tocat l'origen (ver JSDoc de
      // OrderFormValues.origen) — s'omet la clau del tot, no es manda
      // `null` al PATCH (que el backend interpretaria com "no vingut",
      // però és més clar no incloure-la).
      if (values.origen !== null) {
        cos.origen = values.origen;
      }
      await api.patch<ComandaDetallApi>(`/comandes/${id}`, cos);
      refetch();
    },
    [refetch],
  );

  const deleteLine = useCallback(
    async (comandaId: number, liniaId: number) => {
      await api.delete(`/comandes/${comandaId}/linies/${liniaId}`);
      refetch();
    },
    [refetch],
  );

  // Único camino real hacia amb_incidencia: detall es obligatori al
  // backend (400 si arriba buit), la pantalla ha de pedirlo abans de cridar.
  const markIncidence = useCallback(
    async (comandaId: number, detall: string): Promise<ComandaDetallApi> => {
      const actualitzada = await api.patch<ComandaDetallApi>(`/comandes/${comandaId}`, {
        estat: 'amb_incidencia',
        detall,
      });
      refetch();
      return actualitzada;
    },
    [refetch],
  );

  // Agregar una línia a una comanda ja creada.
  const addLine = useCallback(
    async (comandaId: number, linia: LiniaCreacioApi): Promise<ComandaDetallApi> => {
      const actualitzada = await api.post<ComandaDetallApi>(`/comandes/${comandaId}/linies`, linia);
      refetch();
      return actualitzada;
    },
    [refetch],
  );

  // Editar unitatsDemanades/kgDemanats/dataProduccio/obsProduccio d'una
  // línia existent. Mai re-resol preuUnitari (ver LiniaEdicioApi).
  const editLine = useCallback(
    async (
      comandaId: number,
      liniaId: number,
      patch: LiniaEdicioApi,
    ): Promise<ComandaDetallApi> => {
      const actualitzada = await api.patch<ComandaDetallApi>(
        `/comandes/${comandaId}/linies/${liniaId}`,
        patch,
      );
      refetch();
      return actualitzada;
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
    createOrder,
    editOrder,
    deleteLine,
    markIncidence,
    addLine,
    editLine,
  };
}
