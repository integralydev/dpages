// Cliente HTTP base para hablar con el backend real de dPagès.
//
// Regla de tipos del proyecto: TODO tipo de dato que viaja entre frontend
// y backend se define acá, con el sufijo `Api` (ej. `ComandaApi`,
// `ProducteApi`, `ClientApi`, `TarifaApi`). Ningún otro archivo del
// frontend debe declarar sus propios tipos de dominio sueltos
// (nada de catalog.ts, comanda.ts, client.ts fuera de este archivo):
// eso duplicaría el contrato y lo desincroniza del backend.
//
// Los componentes de UI nunca deben llamar fetch() directamente contra
// el backend: pasan siempre por un hook de /hooks, que a su vez usa las
// funciones de este archivo (`api.get`/`api.post`/`api.patch`/`api.delete`).
//
// Se conecta pantalla por pantalla. Primera pantalla real: Categories
// (hooks/useCategories.ts) — el resto sigue consumiendo mocks hasta que le
// toque su turno.

import type {
  CodiErrorApi,
  CosErrorApi,
  DetallErrorApi,
  Paginacio,
  RespostaPaginada,
} from '@dpages/shared';

export type {
  CategoriaApi,
  ProducteApi,
  TarifaResumApi,
  FilaMatriuTarifesApi,
  ClientApi,
  TransportistaApi,
  OrigenComandaApi,
  ReferenciaApi,
  ComandaResumApi,
  ComandaDetallApi,
  ComandaLiniaApi,
  ComandaCreacioApi,
  LiniaCreacioApi,
  LiniaEdicioApi,
  IncidenciaComandaApi,
  LliuramentBodyApi,
  LliuramentRespostaApi,
  RendimentPorcApi,
  RendimentPorcEntradaApi,
  TreballBodyApi,
  TreballLiniaRespostaApi,
  Paginacio,
  UsuariApi,
  UsuariCreacioApi,
  UsuariCreatRespostaApi,
  RolApi,
  RespostaPaginada,
  PanellOficinaApi,
  FilaPanellOficinaApi,
  TotalsPanellOficinaApi,
  PanellObradorApi,
  FilaPanellObradorApi,
  TotalsPanellObradorApi,
  PanellEmpaquetatApi,
  FilaPanellEmpaquetatApi,
  TotalsPanellEmpaquetatApi,
  PanellProduccioApi,
  PanellProduccioFilaApi,
} from '@dpages/shared';

// ── Cliente HTTP ────────────────────────────────────────────────────────

const API_BASE_URL = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1`;

/**
 * Punto de inyección del token de Firebase (tarea 5 de esta sesión). Hasta
 * que `useAuth.tsx` llame a `setAuthTokenProvider` con `user.getIdToken`,
 * esto devuelve `null` — las peticiones salen sin `Authorization`, tal como
 * las rechazaría el backend real (`401 NO_AUTENTICAT`, contrato §2), pero
 * sin romper esta capa ni bloquearla por la tarea 5.
 */
let authTokenProvider: () => Promise<string | null> = async () => null;

export function setAuthTokenProvider(provider: () => Promise<string | null>): void {
  authTokenProvider = provider;
}

/**
 * Códigos de `CodiErrorApi` (contrato §2) más un puñado de códigos propios
 * del cliente para errores que nunca llegan a tener una respuesta del
 * backend con esa forma (falla de red, respuesta sin JSON válido).
 */
export type CodiErrorClient = CodiErrorApi | 'ERROR_XARXA' | 'RESPOSTA_INVALIDA';

/** Excepción tipada que lanzan `api.get`/`post`/`patch`/`delete` — pensada para capturarse de forma consistente en cualquier hook. */
export class ApiError extends Error {
  readonly codi: CodiErrorClient;
  readonly detalls?: DetallErrorApi[];
  readonly status: number | null;

  constructor(
    codi: CodiErrorClient,
    missatge: string,
    status: number | null,
    detalls?: DetallErrorApi[],
  ) {
    super(missatge);
    this.name = 'ApiError';
    this.codi = codi;
    this.status = status;
    this.detalls = detalls;
  }
}

async function parseErrorBody(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as CosErrorApi;
    if (body?.error?.codi && body.error.missatge) {
      return new ApiError(
        body.error.codi,
        body.error.missatge,
        response.status,
        body.error.detalls,
      );
    }
  } catch {
    // La respuesta de error no trae JSON válido con la forma del contrato — cae al genérico de abajo.
  }
  return new ApiError(
    'RESPOSTA_INVALIDA',
    `Error ${response.status} sense cos d'error vàlid.`,
    response.status,
  );
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await authTokenProvider();
  const headers: Record<string, string> = {
    'Accept-Language': 'ca',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (caught) {
    throw new ApiError(
      'ERROR_XARXA',
      caught instanceof Error ? caught.message : "No s'ha pogut connectar amb el servidor.",
      null,
    );
  }

  if (!response.ok) throw await parseErrorBody(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

type QueryValue = string | number | boolean | (string | number)[] | undefined;

// Un array es manda com a paràmetre repetit (`?producte=A&producte=B`),
// que és com el backend rep els filtres de valor múltiple.
function withQuery(path: string, params?: Record<string, QueryValue>): string {
  if (!params) return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export const api = {
  get: <T>(path: string, params?: Record<string, QueryValue>) =>
    request<T>('GET', withQuery(path, params)),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

// ── Hooks "de taula completa" ───────────────────────────────────────────

/**
 * El backend té un topall dur de 200 files per petició (MIDA_PAGINA_MAXIMA,
 * comu.ts) — cap `mida` per damunt es respecta. Els hooks "de taula
 * completa" (useCatalog, useClientTariffs) que es criden SENSE `mida`
 * explícit necessiten TOTES les files igual (353 productes, 1291 clients
 * reals, tots dos per damunt de 200), no una pàgina — sense això, els
 * consumidors que en depenen (options de filtres, resolució de nom/codi)
 * es quedaven en silenci amb només les primeres 200.
 *
 * Demana la primera pàgina per conèixer `totalPagines`, i si n'hi ha més
 * d'una, la resta EN PARAL·LEL (`Promise.all`, no en sèrie — amb 2 pàgines
 * de 200 no val la pena esperar-les una darrere l'altra). Mai s'ha de fer
 * servir al camí de paginació real d'una pantalla pròpia (aquella sempre
 * passa `mida` explícit i vol una sola pàgina, no el total combinat).
 */
export async function obtenirTotesLesPagines<T>(
  demanarPagina: (pagina: number) => Promise<RespostaPaginada<T>>,
): Promise<T[]> {
  const primera = await demanarPagina(1);
  if (primera.paginacio.totalPagines <= 1) return primera.dades;

  const restants = await Promise.all(
    Array.from({ length: primera.paginacio.totalPagines - 1 }, (_, index) =>
      demanarPagina(index + 2),
    ),
  );
  return [primera, ...restants].flatMap((resposta) => resposta.dades);
}

/** Paginació sintètica per a un dataset ja combinat sencer (ver `obtenirTotesLesPagines`) — honesta amb el total real, no una pàgina més. */
export function paginacioTaulaCompleta(total: number): Paginacio {
  return { pagina: 1, mida: total, total, totalPagines: 1 };
}
