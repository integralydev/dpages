import type { ProducteApi } from './api';

// Compartit entre tots els combobox de producte en mode local (filtra en
// memòria el catàleg ja carregat). Tasca 18 (01/10/2026): coincidència pel
// PRINCIPI de la descripció o del codi, igual que GET /productes?cerca= i
// GET /tarifes/matriu?cerca= — "llom" troba "Llom fresc" però no "Cap de
// llom". Abans era "conté el text" en qualsevol posició.
export const MAX_LOCAL_COMBOBOX_RESULTS = 8;

export function matchesProductQuery(product: ProducteApi, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    product.descripcio.toLowerCase().startsWith(normalized) ||
    (product.codi ?? '').toLowerCase().startsWith(normalized)
  );
}
