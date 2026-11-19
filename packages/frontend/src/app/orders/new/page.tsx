'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { GuardedLink } from '@/components/ui/GuardedLink';
import { useCarriers } from '@/hooks/useCarriers';
import { useCatalog } from '@/hooks/useCatalog';
import { useClientTariffs } from '@/hooks/useClientTariffs';
import { useNavigationGuard } from '@/hooks/useNavigationGuard';
import { extractComandaErrorMessage, useOrders } from '@/hooks/useOrders';
import { useOrigensComanda } from '@/hooks/useOrigensComanda';
import { useRates } from '@/hooks/useRates';
import type { ComandaDetallApi } from '@/lib/api';
import { OrderForm, type OrderFormHandle } from '../OrderForm';
import { useAlcadaBarraFixa } from '@/hooks/useAlcadaBarraFixa';

export default function NewOrderPage() {
  const router = useRouter();
  const { createOrder } = useOrders();
  const { data: clients } = useClientTariffs();
  const { tariffColumns } = useRates();
  const { data: carriers } = useCarriers();
  const { data: products } = useCatalog();
  const { data: origins } = useOrigensComanda();
  const formRef = useRef<OrderFormHandle>(null);
  // Alçada de la barra fixa, per als títols fixos de les línies (OrderForm).
  const { mesurar: mesurarBarraFixa, estil: estilBarraFixa } = useAlcadaBarraFixa();
  const [error, setError] = useState<string | null>(null);
  const [createdOrder, setCreatedOrder] = useState<ComandaDetallApi | null>(null);
  const [patchWarning, setPatchWarning] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasDateErrors, setHasDateErrors] = useState(false);
  const { setIsDirty } = useNavigationGuard();

  // Issue #15 — neteja el flag global en desmuntar-se (navegar-se'n
  // d'aquesta pàgina de qualsevol manera) perquè no quedi bloquejant la
  // resta de l'app per sempre; NavigationGuardContext és un únic flag
  // compartit per tota l'app, no propi d'aquesta pàgina.
  useEffect(() => () => setIsDirty(false), [setIsDirty]);

  async function handleSave(values: Parameters<typeof createOrder>[0]) {
    setError(null);
    setPatchWarning(null);
    setIsSaving(true);
    try {
      const { order, patchError } = await createOrder(values);
      setCreatedOrder(order);
      if (patchError) {
        setPatchWarning(
          `La comanda ${order.num} s'ha creat correctament, però alguns camps de capçalera no s'han pogut desar: ${extractComandaErrorMessage(patchError, patchError.message)}. Podeu revisar-los i tornar-los a desar des de la comanda.`,
        );
      } else {
        router.push(`/orders/${order.id}`);
      }
    } catch (caught) {
      setError(extractComandaErrorMessage(caught, "No s'ha pogut crear la comanda."));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div style={estilBarraFixa}>
      {/* Issue #15 — sticky, no fixed: manté el mateix ample/columna que la
          resta de la pàgina (dins del padding de <main>), no cal cap
          marge negatiu. top-14 a mòbil deixa lloc a la barra fixa del
          Sidebar (h-14, ver Sidebar.tsx); lg:top-0 perquè en desktop no hi
          ha cap barra per sobre. bg-[var(--background)] evita que el
          contingut que scrolleja per sota es vegi a través. */}
      <div
        ref={mesurarBarraFixa}
        className="sticky top-14 z-20 mb-8 flex flex-wrap items-center justify-between gap-4 bg-[var(--background)] py-3 lg:top-0"
      >
        <div className="flex items-center gap-4">
          <GuardedLink
            href="/orders"
            className="flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft className="h-4 w-4" />
            Tornar
          </GuardedLink>
          <h1 className="text-2xl font-bold text-gray-900 lg:text-3xl">Nova comanda</h1>
        </div>
        <button
          type="button"
          onClick={() => formRef.current?.submit()}
          disabled={isSaving || createdOrder !== null || hasDateErrors}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSaving ? 'Desant...' : 'Desar'}
        </button>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {patchWarning && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-800">{patchWarning}</p>
          {createdOrder && (
            <GuardedLink
              href={`/orders/${createdOrder.id}`}
              className="shrink-0 rounded-full border border-amber-300 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
            >
              Anar a la comanda
            </GuardedLink>
          )}
        </div>
      )}

      <OrderForm
        ref={formRef}
        mode="create"
        clients={clients}
        tariffs={tariffColumns}
        carriers={carriers}
        products={products}
        origins={origins}
        onSave={handleSave}
        onDateErrorsChange={setHasDateErrors}
        onDirtyChange={setIsDirty}
      />
    </div>
  );
}
