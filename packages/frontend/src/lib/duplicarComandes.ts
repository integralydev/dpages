import { api, type ComandaDuplicadaApi } from '@/lib/api';

/** Tasca 17: duplica les comandes indicades (ids públics). Totes o cap. */
export async function duplicarComandes(ids: number[]): Promise<ComandaDuplicadaApi[]> {
  const resposta = await api.post<{ comandes: ComandaDuplicadaApi[] }>('/comandes/duplicar', {
    ids,
  });
  return resposta.comandes;
}

/**
 * Llista de números de comanda llegible: els consecutius s'agrupen en un
 * rang ("del 000258 al 000260"), la resta van un per un.
 * Ex.: 000258, 000259, 000260, 000265 → "del 000258 al 000260 i 000265".
 */
export function formatarNumsComandes(nums: string[]): string {
  const ordenats = [...nums].sort((a, b) => Number(a) - Number(b));
  const trams: string[][] = [];
  for (const num of ordenats) {
    const tram = trams.at(-1);
    if (tram && Number(num) === Number(tram.at(-1)) + 1) tram.push(num);
    else trams.push([num]);
  }
  // Dos consecutius no fan rang: van com dos elements més de la llista.
  const textos = trams.flatMap((tram) =>
    tram.length <= 2 ? tram : [`del ${tram[0]} al ${tram.at(-1)}`],
  );
  if (textos.length === 1) return textos[0]!;
  return `${textos.slice(0, -1).join(', ')} i ${textos.at(-1)}`;
}
