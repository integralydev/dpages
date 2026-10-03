import { api, type ComandaDetallApi, type ComandaResumApi } from '@/lib/api';

/** Tasca 14: elimina una comanda. El backend respon 409 si ja té res generat. */
export function eliminarComanda(id: number): Promise<unknown> {
  return api.delete(`/comandes/${id}`);
}

/**
 * Si val la pena oferir "Eliminar": les de WooCommerce i les congelades mai
 * es poden eliminar. La resta de condicions (línies fetes o empaquetades)
 * les valida el backend i ho explica si no es pot.
 */
export function potEliminarComanda(comanda: ComandaResumApi | ComandaDetallApi): boolean {
  return comanda.origen !== 'woocommerce' && !comanda.congelada;
}
