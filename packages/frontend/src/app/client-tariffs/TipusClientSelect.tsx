'use client';

import { useState } from 'react';
import { ApiError, type ClientApi, type TipusClient } from '@/lib/api';
import { TIPUS_CLIENT_OPTIONS } from '@/lib/tipusClient';

/**
 * Punt 35 (18/11/2026): canviar el tipus de client des del llistat, sense
 * obrir la fitxa. Es desa en triar l'opció; mentre es desa, el desplegable
 * queda desactivat, i si falla torna al valor d'abans amb l'error a sota.
 */
export function TipusClientSelect({
  client,
  onChange,
}: {
  client: ClientApi;
  onChange: (id: number, tipus: TipusClient) => Promise<void>;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(tipus: TipusClient) {
    setIsSaving(true);
    setError(null);
    try {
      await onChange(client.id, tipus);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "No s'ha pogut desar.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div>
      <select
        aria-label={`Tipus de client de ${client.nom ?? client.codi ?? client.id}`}
        value={client.tipus}
        disabled={isSaving}
        onChange={(event) => handleChange(event.target.value as TipusClient)}
        className="block w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 focus:border-brand focus:outline-none disabled:cursor-wait disabled:opacity-60"
      >
        {TIPUS_CLIENT_OPTIONS.map((opcio) => (
          <option key={opcio.value} value={opcio.value}>
            {opcio.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
