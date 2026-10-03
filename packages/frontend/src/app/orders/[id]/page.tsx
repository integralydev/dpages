'use client';

import { ArrowLeft, Copy, FileText } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { GuardedLink } from '@/components/ui/GuardedLink';
import { useCarriers } from '@/hooks/useCarriers';
import { useCatalog } from '@/hooks/useCatalog';
import { useClientTariffs } from '@/hooks/useClientTariffs';
import { useNavigationGuard } from '@/hooks/useNavigationGuard';
import { extractComandaErrorMessage, type OrderLineChanges, useOrders } from '@/hooks/useOrders';
import { useOrigensComanda } from '@/hooks/useOrigensComanda';
import { useRates } from '@/hooks/useRates';
import { api, ApiError, type ComandaDetallApi, type ComandaDuplicadaApi } from '@/lib/api';
import { duplicarComandes } from '@/lib/duplicarComandes';
import { descarregarPdfComandes } from '@/lib/ordersPdf';
import { OrderForm, type OrderFormHandle } from '../OrderForm';
import { ResultatDuplicatDialog } from '../ResultatDuplicatDialog';

// Avís específic quan el "Desar" falla DESPRÉS d'haver-hi hagut algun
// DELETE de línia real i exitós en aquesta sessió d'edició — el pedido
// pot haver quedat a mitges (línia vella ja eliminada, canvis nous no
// guardats). S'afegeix al missatge real de l'error (mai el reemplaça:
// perdre el detall concret del que va fallar seria un pas enrere), no és
// un missatge genèric nou.
const AVIS_LINIA_JA_ELIMINADA =
  "Alguna línia ja s'ha eliminat correctament, però els canvis nous no s'han guardat — revisa la comanda abans de tornar-ho a intentar.";

function ambAvisSiCal(missatge: string, hiHaLiniaEliminada: boolean): string {
  return hiHaLiniaEliminada ? `${missatge} ${AVIS_LINIA_JA_ELIMINADA}` : missatge;
}

export default function OrderDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { editOrder, deleteLine, markIncidence, addLine, editLine } = useOrders();
  const { data: clients } = useClientTariffs();
  const { tariffColumns } = useRates();
  const { data: carriers } = useCarriers();
  const { data: products } = useCatalog();
  const { data: origins } = useOrigensComanda();
  const formRef = useRef<OrderFormHandle>(null);
  const { setIsDirty } = useNavigationGuard();
  // Còpia local de l'estat "canvis sense desar" per al botó Duplicar.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const [order, setOrder] = useState<ComandaDetallApi | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lineWarning, setLineWarning] = useState<string | null>(null);
  // Borrar una línia existent és un DELETE real i immediat (no espera al
  // "Desar" — ver comentari a OrderForm.tsx, removeLine). Si després
  // d'això el "Desar" falla (afegir la línia de recanvi, o qualsevol
  // altra cosa), el pedido queda a mitges: la línia vella ja no hi és,
  // però els canvis nous tampoc s'han guardat. Es trackeja acá (mateix
  // component on viu handleDeleteLine i handleSave) perquè el missatge
  // d'error ho pugui advertir explícitament, en comptes de mostrar el
  // mateix text que qualsevol altre fallo de guardat.
  const [hasDeletedLineThisSession, setHasDeletedLineThisSession] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasDateErrors, setHasDateErrors] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [incidenceDetall, setIncidenceDetall] = useState('');
  const [incidenceError, setIncidenceError] = useState<string | null>(null);
  const [isMarkingIncidence, setIsMarkingIncidence] = useState(false);

  // Issue #15 — mateix criteri que orders/new/page.tsx: neteja el flag
  // global en desmuntar-se perquè no quedi bloquejant la resta de l'app.
  useEffect(() => () => setIsDirty(false), [setIsDirty]);

  // Se pide por id directo (GET /comandes/:id), no se busca en una lista ya
  // cargada — mismo criterio que Catàleg. `congelada` viene ya resuelto acá
  // (ComandaDetallApi.congelada/congelatA), así que la pantalla puede
  // deshabilitar la edición desde el arranque, sin esperar a un 409.
  useEffect(() => {
    let cancelled = false;
    // Fetch a un sistema extern (API): el reset síncron d'isLoading/error
    // just abans de cridar-lo és el patró de React per a data fetching en
    // efectes, no un valor derivable durant el render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setLoadError(null);

    api
      .get<ComandaDetallApi>(`/comandes/${params.id}`)
      .then((resposta) => {
        if (!cancelled) setOrder(resposta);
      })
      .catch((caught) => {
        if (!cancelled) {
          setLoadError(
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
  }, [params.id, reloadToken]);

  async function handleSave(
    values: Parameters<typeof editOrder>[1],
    lineChanges: OrderLineChanges,
  ) {
    if (!order) return;
    setSaveError(null);
    setLineWarning(null);
    setIsSaving(true);

    let headerFailed = false;
    async function desarCapcalera() {
      if (!order) return;
      try {
        await editOrder(order.id, values);
      } catch (caught) {
        headerFailed = true;
        setSaveError(
          ambAvisSiCal(
            extractComandaErrorMessage(caught, "No s'ha pogut desar la comanda."),
            hasDeletedLineThisSession,
          ),
        );
      }
    }

    // Tasca 15: el backend valida la capçalera contra les línies TAL COM
    // ESTAN guardades (regla 4: cap línia anterior a la data de producció
    // de capçalera). Si la data de producció de capçalera s'avança, les
    // línies que la seguien s'han d'avançar ABANS (si no, la capçalera
    // xocaria amb les dates velles); si s'endarrereix, la capçalera va
    // primer (si no, les línies noves xocarien amb la capçalera vella).
    const capcaleraDespres =
      values.dataProduccio !== null &&
      order.dataProduccio !== null &&
      values.dataProduccio.slice(0, 10) > order.dataProduccio.slice(0, 10);
    if (!capcaleraDespres) await desarCapcalera();

    // Una llamada por línia nova/editada (el backend no ofereix un
    // endpoint batch). Cap error interromp les altres: es guarden totes
    // les que es puguin i s'avisa amb el detall de les que han fallat.
    // El cas delicat: editar NOMÉS la capçalera (headerFailed amunt)
    // també pot xocar amb una línia existent que ni tan sols
    // s'estigui tocant en aquest request (ver comentari a comandes.ts,
    // PATCH /comandes/:id) — extractComandaErrorMessage ja inclou quina
    // línia és, encara que aquí no hi hagi cap `lineChanges` que la referenci.
    const lineErrors: string[] = [];
    for (const novaLinia of lineChanges.novaLinies) {
      try {
        await addLine(order.id, novaLinia);
      } catch (caught) {
        lineErrors.push(extractComandaErrorMessage(caught, "No s'ha pogut afegir una línia."));
      }
    }
    for (const { liniaId, patch } of lineChanges.liniesEditades) {
      try {
        await editLine(order.id, liniaId, patch);
      } catch (caught) {
        lineErrors.push(extractComandaErrorMessage(caught, "No s'ha pogut editar una línia."));
      }
    }
    if (capcaleraDespres) await desarCapcalera();
    if (lineErrors.length > 0) {
      setLineWarning(ambAvisSiCal(lineErrors.join(' '), hasDeletedLineThisSession));
    }

    setIsSaving(false);
    if (!headerFailed && lineErrors.length === 0) {
      router.push('/orders');
    } else {
      setReloadToken((token) => token + 1);
    }
  }

  async function handleDeleteLine(liniaId: number) {
    if (!order) return;
    await deleteLine(order.id, liniaId);
    // Si `deleteLine` llença, aquesta línia no s'arriba a executar — només
    // marca el flag quan el DELETE ha estat realment exitós.
    setHasDeletedLineThisSession(true);
    setReloadToken((token) => token + 1);
  }

  // Tasca 17: duplica la comanda tal com està desada (per això cal desar
  // abans si hi ha canvis pendents).
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicades, setDuplicades] = useState<ComandaDuplicadaApi[] | null>(null);

  async function handleDuplicate() {
    if (!order) return;
    setIsDuplicating(true);
    setDuplicateError(null);
    try {
      setDuplicades(await duplicarComandes([order.id]));
    } catch (caught) {
      setDuplicateError(
        caught instanceof ApiError
          ? `No s'ha pogut duplicar la comanda: ${caught.message}`
          : "No s'ha pogut duplicar la comanda.",
      );
    } finally {
      setIsDuplicating(false);
    }
  }

  // Tasca 13: la comanda desada, en PDF.
  const [isPrinting, setIsPrinting] = useState(false);

  async function handlePrint() {
    if (!order) return;
    setIsPrinting(true);
    setDuplicateError(null);
    try {
      await descarregarPdfComandes({
        comandes: [order],
        clients: new Map(clients.map((client) => [client.id, client])),
        originLabel: (codi) => origins.find((origin) => origin.codi === codi)?.nom ?? codi,
      });
    } catch {
      setDuplicateError("No s'ha pogut generar el PDF de la comanda.");
    } finally {
      setIsPrinting(false);
    }
  }

  async function handleConfirmIncidence() {
    if (!order) return;
    setIsMarkingIncidence(true);
    setIncidenceError(null);
    try {
      await markIncidence(order.id, incidenceDetall.trim());
      setConfirmOpen(false);
      setIncidenceDetall('');
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setIncidenceError(
        caught instanceof ApiError ? caught.message : "No s'ha pogut marcar la incidència.",
      );
    } finally {
      setIsMarkingIncidence(false);
    }
  }

  return (
    <div>
      {/* Issue #15 — mateix patró que orders/new/page.tsx: sticky (no
          fixed), sense marge negatiu, top-14 a mòbil per la barra fixa
          del Sidebar, lg:top-0 en desktop. */}
      <div className="sticky top-14 z-20 mb-8 flex flex-wrap items-center justify-between gap-4 bg-[var(--background)] py-3 lg:top-0">
        <div className="flex items-center gap-4">
          <GuardedLink
            href="/orders"
            className="flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft className="h-4 w-4" />
            Tornar
          </GuardedLink>
          <h1 className="text-2xl font-bold text-gray-900 lg:text-3xl">
            Comanda {order?.num ?? params.id}
          </h1>
          {order?.congelada && <Badge variant="neutral">Congelada</Badge>}
        </div>
        {order && (
          <div className="flex items-center gap-3">
            {order.estat !== 'amb_incidencia' &&
              order.estat !== 'cancellada' &&
              !order.congelada && (
                <button
                  type="button"
                  onClick={() => {
                    setIncidenceError(null);
                    setIncidenceDetall('');
                    setConfirmOpen(true);
                  }}
                  className="rounded-full border border-red-300 px-5 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-50"
                >
                  Marcar com a incidència
                </button>
              )}
            <button
              type="button"
              onClick={handlePrint}
              disabled={isPrinting || hasUnsavedChanges}
              title={hasUnsavedChanges ? "Desa els canvis abans d'imprimir la comanda" : undefined}
              className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FileText className="h-4 w-4" />
              {isPrinting ? 'Generant PDF...' : 'Imprimir comanda'}
            </button>
            <button
              type="button"
              onClick={handleDuplicate}
              disabled={isDuplicating || hasUnsavedChanges}
              title={hasUnsavedChanges ? 'Desa els canvis abans de duplicar la comanda' : undefined}
              className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Copy className="h-4 w-4" />
              {isDuplicating ? 'Duplicant...' : 'Duplicar comanda'}
            </button>
            <button
              type="button"
              onClick={() => formRef.current?.submit()}
              disabled={isSaving || order.congelada || hasDateErrors}
              className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? 'Desant...' : 'Desar'}
            </button>
          </div>
        )}
      </div>

      {isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {loadError && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;ha pogut carregar la comanda: {loadError.message}
          </p>
          <button
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
            className="shrink-0 rounded-full border border-red-300 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            Torna-ho a provar
          </button>
        </div>
      )}

      {saveError && <p className="mb-4 text-sm text-red-600">{saveError}</p>}
      {duplicateError && <p className="mb-4 text-sm text-red-600">{duplicateError}</p>}
      {lineWarning && <p className="mb-4 text-sm text-amber-700">{lineWarning}</p>}

      {order && (
        <OrderForm
          ref={formRef}
          mode="edit"
          initialData={order}
          isFrozen={order.congelada}
          clients={clients}
          tariffs={tariffColumns}
          carriers={carriers}
          products={products}
          origins={origins}
          onSave={handleSave}
          onDeleteLine={handleDeleteLine}
          onDateErrorsChange={setHasDateErrors}
          onDirtyChange={(dirty) => {
            setIsDirty(dirty);
            setHasUnsavedChanges(dirty);
          }}
        />
      )}

      <ResultatDuplicatDialog
        creades={duplicades}
        onClose={() => setDuplicades(null)}
        onOpen={(id) => {
          setDuplicades(null);
          router.push(`/orders/${id}`);
        }}
      />

      <ConfirmDialog
        isOpen={confirmOpen}
        title="Marcar com a incidència"
        message={`Vols marcar la comanda ${order?.num ?? ''} com a incidència?`}
        confirmLabel="Marcar"
        confirmingLabel="Marcant..."
        cancelLabel="Cancel·lar"
        errorMessage={incidenceError}
        isConfirming={isMarkingIncidence}
        detailField={{
          label: 'Motiu',
          value: incidenceDetall,
          onChange: setIncidenceDetall,
          placeholder: 'Explica per què es marca aquesta comanda com a incidència',
        }}
        onConfirm={handleConfirmIncidence}
        onCancel={() => {
          setConfirmOpen(false);
          setIncidenceError(null);
          setIncidenceDetall('');
        }}
      />
    </div>
  );
}
