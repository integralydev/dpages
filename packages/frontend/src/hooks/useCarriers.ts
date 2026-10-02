'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Paginacio,
  type RespostaPaginada,
  type TransportistaApi,
} from '@/lib/api';
import { usePageClamp } from './usePageClamp';

// Decisió de negoci: "codi" surt de la UI de Transportistes per complet —
// ni es demana ni es mostra. El backend NO
// canvia (POST/PATCH el segueixen acceptant com a opcional), però la
// clau `codi` s'ha d'ometre del tot al body, no mandar-la com a `null`:
// el PATCH real (transportistes.ts) fa `codi = CASE WHEN cos.codi !==
// undefined THEN cos.codi ELSE codi END` — mandar `codi: null` esborraria
// el codi d'un transportista que ja el tingués carregat d'abans d'aquest
// canvi; ometre la clau el deixa intacte.
export type CarrierFormValues = Pick<TransportistaApi, 'nom'>;

/**
 * `mida` per defecte es manté a 200 (no 20): `useCarriers()` es fa servir
 * com a taula de consulta completa en 4 llocs fora de la seva pròpia
 * pantalla (packaging, office, orders/new, orders/[id]) per omplir el
 * `SelectFilter`/select de transportista — necessiten TOTS els
 * transportistes, no una sola pàgina. Només `app/transportistes/page.tsx`
 * passa `mida: MIDA_PAGINA_LLISTATS` explícit per paginar de veritat la seva pròpia llista.
 */
export type UseCarriersParams = { mida?: number };

type UseCarriersResult = {
  data: TransportistaApi[];
  paginacio: Paginacio | null;
  pagina: number;
  setPagina: (pagina: number) => void;
  isLoading: boolean;
  error: ApiError | null;
  refetch: () => void;
  createCarrier: (values: CarrierFormValues) => Promise<void>;
  editCarrier: (id: number, values: CarrierFormValues) => Promise<void>;
};

const MIDA_PER_DEFECTE = 200;

export function useCarriers(params: UseCarriersParams = {}): UseCarriersResult {
  const { mida = MIDA_PER_DEFECTE } = params;
  const [data, setData] = useState<TransportistaApi[]>([]);
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
      .get<RespostaPaginada<TransportistaApi>>('/transportistes', { mida, pagina })
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

  // Hallazgo A (auditoria de paginació) — corregeix `pagina` si un canvi
  // deixa l'usuari en una pàgina que ja no existeix. Al mode "taula
  // completa" (mida=200 per defecte, sense combinar múltiples pàgines com
  // useCatalog.ts) mai s'arriba a disparar: res canvia `pagina` en aquest
  // mode, sempre queda a 1.
  usePageClamp(paginacio, setPagina);

  // Sin edición optimista, mismo criterio que useCategories.ts: el backend
  // devuelve la fila creada/editada, más simple re-pedir la lista.
  const createCarrier = useCallback(
    async (values: CarrierFormValues) => {
      await api.post<TransportistaApi>('/transportistes', values);
      refetch();
    },
    [refetch],
  );

  const editCarrier = useCallback(
    async (id: number, values: CarrierFormValues) => {
      await api.patch<TransportistaApi>(`/transportistes/${id}`, values);
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
    createCarrier,
    editCarrier,
  };
}
