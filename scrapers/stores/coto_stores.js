/**
 * 🏬 Scraper de SUCURSALES de Coto — NO-OP DOCUMENTADO
 *
 * Este scraper NO trae datos hoy. Es intencional, no un bug pendiente:
 *
 *   (a) SPIKE fallido: se intentó capturar el XHR del selector "elegí tu
 *       sucursal" del SPA de coto.com.ar (DevTools → Network) para mapear
 *       nombre/dirección/coordenadas por sucursal. No se pudo capturar sin
 *       interacción profunda con el flujo de compra del SPA — la página
 *       legacy `/sucursales/` es una landing de marketing muerta que no
 *       dispara ningún actor ATG con la lista real de sucursales al cargar.
 *       Por diseño (spec aprobada) NO se adivinan endpoints ATG: en
 *       investigaciones previas devolvieron 500.
 *
 *   (b) Las sucursales de Coto YA EXISTEN por código: `saveCotoProduct`
 *       (scraper de PRODUCTOS, Task 5) bootstrapea filas en `merchant_stores`
 *       a partir del código de sucursal que trae cada producto. El sync de
 *       Laravel (`StoreSyncService::syncMerchant('coto')`) puede resolver la
 *       fuente 'coto' sin problema; simplemente no tiene nada que enriquecer
 *       mientras este scraper devuelva `stores: []`.
 *
 *   (c) El enriquecimiento (nombre real, dirección, coordenadas) de esas
 *       filas se hace HOY manualmente vía backoffice (Filament, Task 10) —
 *       un operador completa los datos por sucursal a partir de fuentes
 *       públicas (Google Maps, la web de Coto, etc.).
 *
 *   (d) Para actualizar esto en el futuro: capturar el XHR real del
 *       selector de sucursales del SPA (con el flujo de compra activo, no
 *       solo cargando la página) y mapear su respuesta al mismo contrato
 *       que `scrapers/stores/jumbo_stores.js`:
 *       { external_reference, name, address, city, province, postal_code,
 *         latitude, longitude, phone, opening_hours }.
 *       `external_reference` DEBE ser el código de sucursal de Coto (el
 *       mismo que ya persiste `saveCotoProduct`) para que el upsert por
 *       `external_reference` en `StoreSyncService` enriquezca las filas
 *       existentes en vez de crear duplicados.
 *
 * NO lanza excepciones al caller: ante un hipotético error futuro (cuando
 * deje de ser no-op) debe devolver { success:false, ... }, nunca throw.
 */

/**
 * 🎯 FUNCIÓN PRINCIPAL - Sucursales de Coto (no-op)
 */
export async function getCotoStores() {
  console.log('🏬 Sucursales de Coto: no-op documentado (ver comentario en coto_stores.js). Enriquecimiento vía backoffice.');

  return {
    success: true,
    source: 'coto',
    total: 0,
    stores: [],
    timestamp: new Date().toISOString(),
  };
}
