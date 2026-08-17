/**
 * Guarda de plausibilidad entre sucursales del mismo comercio.
 *
 * El headline de un comercio multi-tienda es el MIN entre sus sucursales, así que UNA fila
 * con basura define el precio que se publica. Caso real de Coto: 31 de 33 sucursales decían
 * $3.859,99 para la misma pasta dental y el headline salía $53,76.
 *
 * Acá hay consenso interno del que agarrarse —la mediana entre sucursales—, así que se
 * descartan las filas que caen muy por debajo de ella antes de tomar el mínimo.
 *
 * ⚠️ Este archivo es el espejo de `App\Services\Prices\PricePlausibility` del lado Laravel,
 * que reconcilia lo mismo en `merchant-store-prices:rollup`. Si se cambia el umbral acá,
 * cambiarlo allá: si no, cada corrida del scraper y cada rollup se pisarían con criterios
 * distintos y el precio publicado dependería de quién escribió último.
 */

/**
 * Fracción de la mediana entre sucursales por debajo de la cual una fila se descarta.
 *
 * Con 0.40 una sucursal puede estar hasta 60% por debajo de la mediana de su propia cadena
 * sin que se la descarte —eso cubre una promo local o una liquidación de una tienda— pero
 * un precio ×70 más barato queda afuera.
 */
export const BANDA_SUCURSAL = 0.4;

export function median(values) {
  const numbers = values.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  if (numbers.length === 0) {
    return 0;
  }

  const middle = Math.floor(numbers.length / 2);

  return numbers.length % 2 === 0
    ? (numbers[middle - 1] + numbers[middle]) / 2
    : numbers[middle];
}

/**
 * Filas de sucursal que pueden definir el headline.
 *
 * Si al filtrar no quedara ninguna —no debería, la mediana siempre está dentro de su propia
 * banda— se devuelven todas: quedarse sin precio es peor que quedarse con uno dudoso.
 */
export function storeRowsWithinBand(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return rows;
  }

  const floor = median(rows.map((r) => r.price)) * BANDA_SUCURSAL;
  const within = rows.filter((r) => Number(r.price) >= floor);

  return within.length > 0 ? within : rows;
}
