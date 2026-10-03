'use client';

import { Modal } from '@/components/ui/Modal';
import type { ComandaDuplicadaApi } from '@/lib/api';
import { formatarNumsComandes } from '@/lib/duplicarComandes';

/**
 * Tasca 17: finestra informativa en acabar de duplicar, amb els números de
 * les comandes noves (els consecutius, en rang).
 */
export function ResultatDuplicatDialog({
  creades,
  onClose,
  onOpen,
}: {
  creades: ComandaDuplicadaApi[] | null;
  onClose: () => void;
  /** Només s'ofereix si s'ha creat una sola comanda. */
  onOpen: (id: number) => void;
}) {
  const nums = creades?.map((comanda) => comanda.num) ?? [];
  const ambOmeses = creades?.filter((comanda) => comanda.liniesOmeses > 0) ?? [];

  return (
    <Modal
      isOpen={creades !== null}
      onClose={onClose}
      title={nums.length === 1 ? 'Comanda duplicada' : 'Comandes duplicades'}
    >
      <p className="text-sm text-gray-600">
        {nums.length === 1 ? (
          <>
            S&apos;ha creat la comanda{' '}
            <span className="font-semibold text-gray-900">{nums[0]}</span>.
          </>
        ) : (
          <>
            S&apos;han creat {nums.length} comandes:{' '}
            <span className="font-semibold text-gray-900">{formatarNumsComandes(nums)}</span>.
          </>
        )}
      </p>
      <p className="mt-2 text-sm text-gray-600">
        {nums.length === 1 ? 'Està' : 'Estan'} en Esborrany, amb data de comanda d&apos;avui i la
        resta de dates en blanc.
      </p>
      {ambOmeses.length > 0 && (
        <p className="mt-2 text-sm text-amber-700">
          No s&apos;han copiat les línies sense article de:{' '}
          {ambOmeses.map((comanda) => `${comanda.origen.num} (${comanda.liniesOmeses})`).join(', ')}
          .
        </p>
      )}
      <div className="mt-6 flex items-center justify-end gap-3">
        {creades?.length === 1 && (
          <button
            type="button"
            onClick={() => onOpen(creades[0]!.id)}
            className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Obrir la comanda
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
        >
          D&apos;acord
        </button>
      </div>
    </Modal>
  );
}
