/**
 * Conversión string↔number para los campos que el backend manda como string
 * (docs/contrato-api.md §2: pesos con 3 decimales, importes con 2 — nunca
 * `number`, para no perder precisión al sumar). `decimals` es explícito,
 * no inferido, porque dos campos con el mismo tipo de dato (string
 * decimal) pueden tener escalas de negocio distintas (kg vs. €).
 */

/**
 * Punto de millares en la parte entera de un texto numérico que ya lleva
 * coma decimal ("1058,465" → "1.058,465", "-12500" → "-12.500"). Petición
 * del cliente (11/11/2026): todas las cantidades e importes de la
 * aplicación se muestran con punto de millares y coma decimal.
 *
 * A mano y no con `Intl.NumberFormat("ca")`: en catalán y castellano la
 * norma tipográfica no agrupa los números de 4 cifras ("1058,465"), y el
 * cliente quiere el punto siempre.
 *
 * SÓLO para mostrar. Nunca en el valor de un campo editable: al escribir,
 * el punto se acepta como separador decimal ("1.250" = 1,25), así que un
 * punto de millares en un input se leería mal al guardar.
 */
export function agruparMilers(text: string): string {
  const [enter = '', ...resta] = text.split(',');
  return [enter.replace(/\B(?=(\d{3})+(?!\d))/g, '.'), ...resta].join(',');
}

/** Para MOSTRAR: string del backend → texto local con punto de millares y coma decimal (sin símbolo de unidad/moneda, eso lo agrega el call site). `null` (ej. pesKg de un article "a mida") → "—". */
export function formatDecimal(value: string | null, decimals: number): string {
  if (value === null) return '—';
  return formatNombre(Number(value), decimals);
}

/** Para MOSTRAR un `number` (totales calculados en el frontend, contadores): mismo formato que `formatDecimal`. Sin `decimals`, entero. */
export function formatNombre(value: number, decimals = 0): string {
  return agruparMilers(value.toFixed(decimals).replace('.', ','));
}

/** Para ENVIAR: number/string de un formulario (coma o punto decimal) → string con la precisión exacta que espera el backend. Nunca produce NaN: un valor no numérico cae a 0. */
export function parseDecimalInput(value: number | string, decimals: number): string {
  const parsed = typeof value === 'number' ? value : Number(value.trim().replace(',', '.'));
  return (Number.isNaN(parsed) ? 0 : parsed).toFixed(decimals);
}
