import { getValtechBankPromotions } from '../../cores/valtechBankPromotions.js';

/**
 * 🏷️ Scraper de PROMOCIONES BANCARIAS de Masonline (ChangoMás)
 *
 * Wrapper fino sobre `cores/valtechBankPromotions.js`: Masonline usa la misma
 * plantilla de Valtech que Carrefour (`valtech.gdn-banks-promotions`, GDN =
 * Grupo De Narváez) y las mismas entidades BP / FB / FC.
 *
 * Diferencias que importan (relevadas el 2026-09-23):
 *   - el título NO dice el banco: sale sólo de `idBank` → FB;
 *   - `hyper`/`maxi` vienen null y el front no lee `market`/`express`: no se
 *     emiten formatos de tienda, el canal real está en el legal;
 *   - el dato estructurado contradice al legal en varios casos (días, %), por eso
 *     viajan `legal` y `dias_texto` completos;
 *   - `isMasClub` marca las promos exclusivas del programa de fidelidad.
 *
 * Medido el 2026-10-10: 40 documentos activos, 40 vigentes.
 */
export async function getMasonlinePromotions(options = {}) {
  return getValtechBankPromotions({
    baseUrl: 'https://www.masonline.com.ar',
    source: 'masonline',
    merchant: 'Masonline',
    withFormats: false,
    ...options,
  });
}
