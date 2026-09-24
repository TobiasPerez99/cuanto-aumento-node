# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **price tracking API** for Argentine merchants. It scrapes product data from multiple merchant websites (primarily VTEX-based stores), stores pricing history in MySQL via Prisma, and exposes REST endpoints for price comparisons.

**Tech Stack:** Node.js, Express, Prisma (MySQL), Upstash Redis, Axios

## Common Commands

### Development
```bash
npm run dev              # Start server with nodemon (hot reload)
npm start                # Start production server
```

### Database (Prisma)
```bash
npx prisma generate      # Generate Prisma client after schema changes
npx prisma migrate dev   # Create and apply migration
npx prisma studio        # Open Prisma Studio GUI
```

### Scraping
```bash
# Run individual scrapers
npm run scrape:disco       # Disco (MASTER - creates product catalog)
npm run scrape:carrefour   # Carrefour (FOLLOWER - updates prices only)
npm run scrape:jumbo       # Jumbo
npm run scrape:vea         # Vea
npm run scrape:dia         # Dia Online
npm run scrape:masonline   # Masonline
npm run scrape:farmacity   # Farmacity
npm run scrape:all         # Run all PRODUCT scrapers sequentially (promos/stores only by name)

# Test scrapers (without DB writes)
npm run test:disco
npm run test:carrefour
# etc...
```

### Catalog dry run (sin tocar la base)
```bash
npm run catalog:dry -- disco          # recorre el catálogo real de Disco y no escribe nada
npm run catalog:dry -- all            # los 7 VTEX + Josimar
npm run test:vtex-catalog-unit        # tests del recorrido (sin red)
```
Imprime, por comercio, cuánto declara el catálogo en su canal, cuánto se recorrió, cuántas requests
hizo y si la corrida habría contado como **completa**. En producción: `./devops.sh scraper-catalog-dry`.

### VTEX Hash Management (sólo modo `search`)
El hash de la persisted query `productSuggestions` **sólo lo usa el modo `search`** (la búsqueda de
texto que quedó como vuelta atrás). El modo por defecto recorre el Catalog System REST y no lo necesita;
su ausencia ya no tumba el servicio al importar `cores/vtex.js`. Si hace falta volver a `search` y el
hash expiró:
```bash
node scripts/extractVtexHash.js
```
Then follow instructions in `COMO_OBTENER_HASH.md` to extract new hash from browser DevTools.

## Architecture

### Master/Follower Pattern

The codebase uses a **master/follower architecture** for product management:

- **MASTER (Disco):** Creates new products in the `products` table (master catalog). Uses `saveMasterProduct()` handler.
- **FOLLOWERS (all others):** Only update prices for products that already exist in master catalog. Uses `saveFollowerProduct()` handler which skips products not in master (`reason: "not_in_master"`).

**Why:** Ensures product catalog integrity. Disco is treated as the canonical source for product metadata (name, brand, category, images).

### Scraping Modes

Scrapers support three modes (passed as argument; `PRODUCT_MODES` in `scripts/populate-db.js`):
- **`categories` (default):** recorre el catálogo entero. Los 7 VTEX y Josimar, por el Catalog System REST
  (`cores/vtexCatalog.js`); Coto, por Constructor.io.
- **`eans`:** sólo los EAN de `PRODUCT_EANS`. **Nunca es una corrida completa**: Laravel no vence
  precios con ella.
- **`search`:** los 7 VTEX vuelven a la búsqueda de texto de GraphQL (`productSuggestions`, top 50 por
  término de `cores/categories.js`, necesita `VTEX_SHA256_HASH`). Es la vuelta atrás, seleccionable desde
  el backoffice de Laravel (`scrapper.schedule_mode`), por si el WAF de un comercio bloquea el recorrido
  REST. Coto y Josimar lo tratan como `categories`.

Example: `npm run scrape:disco categories` or via API: `POST /api/scrape/disco` with body `{ "mode": "eans" }`

### Core Scraping Flow

1. **Scraper files** (`scrapers/*.js`): los 7 VTEX son wrappers de una línea sobre
   `scrapeVtexProducts(key, mode)` (`cores/vtexProducts.js`), que tiene el registro `VTEX_MERCHANTS`
   (dominio, canal de respaldo, maestro/follower) y despacha según el modo.
2. **VTEX catalog core** (`cores/vtexCatalog.js`) — el camino por defecto, ver "VTEX Integration".
   El core viejo de GraphQL (`cores/vtex.js`, `scrapeVtexMerchant`/`fetchVtexProducts`/`normalizeProduct`)
   sigue vivo sólo para el modo `search` y para `scripts/updatePrices.js`.
   - Ambos llaman `onProductFound(product, merchantId)` una vez por EAN, con el mismo contrato de producto.
3. **Save handlers** (`cores/saveHandlers.js`):
   - `saveMasterProduct()`: Upserts into `products`, `merchant_products`, and `price_history`
   - `saveFollowerProduct()`: Only upserts if EAN exists in `products` table
4. **Database** (`prisma/schema.prisma`):
   - `Product`: Master catalog (keyed by EAN)
   - `Merchant`: Merchant directory
   - `MerchantProduct`: Junction table with current prices
   - `PriceHistory`: Historical price snapshots

### API Routes

**Product endpoints** (`routes/productRoutes.js`):
- `GET /api/products` - Paginated product list with current prices
- `GET /api/products/search?q=...` - Search by name
- `GET /api/products/:ean` - Product detail with price history
- `GET /api/products/:ean/cheapest` - Find cheapest merchant
- `GET /api/categories` - List all categories
- `GET /api/stats/categories` - Category statistics

**Scraper endpoints** (`routes/scraperRoutes.js`) - **Require API_TOKEN auth**:
- `POST /api/scrape/:scraperName` - Run single scraper (body: `{ "mode": "categories" | "eans" }`)
- `POST /api/scrape/all` - Run all **product** scrapers (masters first, then followers). Promo
  (`type: 'promo'`) and store (`type: 'stores'`) scrapers are **excluded** — they only run by name
  (`/api/scrape/:scraperName`); Laravel pulls them on its own. Before this, every 3-hour product cron
  also ran the full Galicia scrape (~1,630 requests) and threw the result away. The selection lives in
  `scripts/scraperSelection.js` (`productEntries()`, shared with `runAll()`); `modo` (`type: 'bank'`)
  stays in.
- `GET /api/scrape/status/:jobId` - Check job status
- `GET /api/scrape/jobs` - List all jobs
- `GET /api/scrape/running` - List running scrapers
- `GET /api/scrape/stats` - Job statistics
- `POST /api/scrape/cleanup` - Clean old jobs

### Job Management

Scrapers run asynchronously via `services/jobManager.js`:
- Jobs stored in-memory with UUIDs
- States: `pending` → `running` → `completed` | `failed`
- Auto-cleanup after `JOB_RETENTION_HOURS` (default: 24h)
- Webhook notifications sent on `started` and `completed` events (see `services/webhookService.js`)

### VTEX Integration — recorrido del catálogo REST (SCRAPER-001)

Hasta 2026-09 los 7 comercios VTEX **no recorrían el catálogo**: pedían el top 50 del autocompletado
(`productSuggestions`) para cada uno de 279 términos, sin paginar. Lo que veían dependía del ranking del
buscador, variaba de corrida en corrida y dependía de un hash que caduca solo. Ahora
`scrapeVtexCatalog()` (`cores/vtexCatalog.js`) recorre el árbol entero:

```
GET /api/segments                                      → canal de venta de la tienda
GET /api/catalog_system/pub/category/tree/3            → árbol de categorías
GET /api/catalog_system/pub/products/search?fq=C:/1/17/&fq=isAvailablePerSalesChannel_33:1&sc=33&_from=0&_to=49
```

Medido el 2026-09-22 (spec: `docs/superpowers/specs/2026-09-22-vtex-catalog-walk-design.md` del repo Laravel):

| Comercio | Canal | Disponibles en su canal | Requests por corrida |
|---|---|---|---|
| Disco | 33 | 10.738 | ~278 |
| Jumbo | 32 | 16.071 | ~397 |
| Vea | 34 | 8.406 | ~206 |
| Carrefour | 1 | 29.853 | ~666 |
| Dia | 1 | 4.906 | ~120 |
| Masonline | 1 | 13.929 | ~445 |
| Farmacity | 4 | 14.666 | ~343 |

Gotchas que cuestan caro:
- ⚠️ **Disco, Jumbo y Vea comparten UN catálogo** (mismo árbol, 381.255 productos). Lo que separa a cada
  cadena es el **sales channel**. Sin `fq=isAvailablePerSalesChannel_{canal}:1` el recorrido serían
  cientos de miles de productos que la cadena no vende (y el maestro los crearía). Es la misma semántica
  que `hideUnavailableItems: true` del camino viejo.
- ⚠️ **Con un canal equivocado el filtro no es más laxo: el catálogo sale VACÍO** (`isAvailablePerSalesChannel_1`
  en el host de Disco da 0). Por eso el canal se relee de `/api/segments` en cada corrida (el de
  `VTEX_MERCHANTS` es sólo el respaldo), y una corrida cuyo catálogo declara 0 productos **falla** en vez de
  reportar un éxito vacío.
- ⚠️ **`fq=C:` lleva el path completo**: `C:/17/` (una subcategoría sola) devuelve 0; `C:/1/17/` devuelve
  sus 167. El descenso arma el path desde la raíz.
- Ventana de paginación: `_to - _from ≤ 49` y `_from ≤ 2500` → 2.550 productos por consulta. El recorrido
  baja a los hijos sólo cuando un nodo no entra; una hoja que no entra queda en `oversizedCategories`.
  Hoy ninguna de los 7 la supera.
- El precio REST coincide con el de Intelligent Search (lo que muestra el storefront) en 1.392 de 1.394
  cruces, **descuentos incluidos** (`PriceWithoutDiscount`). Cencosud no usa ese campo: sus rebajas son promos.
- ⚠️ **`ListPrice` viene multiplicado (×90 en Disco).** Se usa `PriceWithoutDiscount`.
- ⚠️ **La API devuelve páginas cortas en el medio de una categoría** (medido en producción en Masonline:
  páginas de 49 con el header diciendo que había más). Tomarlas como el final cortó "Desayunos y Meriendas"
  en 499 de 1.060 y la corrida se reportó completa. Con total conocido `walkTarget` pagina por **posición**
  hasta el total del header (el más reciente) y lo que faltó se informa en `pageGaps`; sólo sin total una
  página corta es el final. No lo detecta una corrida en seco desde otra IP: en seco las páginas vinieron llenas.
- La API tira **500 en ráfagas** (medido en Carrefour y Masonline): la misma URL responde 206 segundos
  después. Por eso cada request se reintenta (1,5 s / 3 s; 429 y 403 con 15 s / 30 s) y, al final, las
  categorías que fallaron sueltas se vuelven a intentar una vez tras 30 s.
- `items[0]`: se toma el primer SKU, igual que el camino viejo. El link se arma con el dominio recorrido +
  `linkText` (el catálogo es compartido: el `link` absoluto podría ser de otra cadena).

**Resultado: "exitosa" no es "completa".** Además de `success`, cada corrida reporta `complete` con su porqué en
`incompleteReasons` (`eans_mode`, `partial`, `failed_categories`, `oversized_categories`, `node_cap`),
`expectedTotal`, `failedCategories`, `oversizedCategories`, `unreachableProducts`, `salesChannel` y `requestCount`.
`unreachableProducts` son los que ninguna consulta alcanza (fuera del árbol, o colgados de un padre sin estar en
ningún hijo): su precio no se refresca, así que **no** vuelven incompleta la corrida y vencen como cualquier otro.
El modo `search` pasa por `markSearchResult()` (`cores/vtexProducts.js`) y sale siempre `complete: false`
(`search_mode`): el top 50 por término nunca recorre el catálogo. Una categoría
que falla después de los reintentos **no** aborta la corrida (los precios que llegaron se guardan) pero la deja
`complete: false`, igual que el modo `eans` o una corrida acotada con `categoryPaths`. Laravel no cuenta
ausencias de una corrida incompleta (`SweepUnseenProducts`, ver CLAUDE.md del repo Laravel). Tres categorías
seguidas caídas (reintentos incluidos) cortan la corrida con `success: false`: eso ya no es un 500 pasajero
sino un bloqueo, y seguir golpeando sólo lo empeora.

**Lo que NO resuelve** (ver `docs/BACKLOG.md` del repo Laravel): un producto sin stock sigue sin volver en el
recorrido (el filtro de disponibilidad es obligatorio en el catálogo compartido), así que se cuenta como
ausencia y no como "sin stock" (SCRAPER-002).

**El camino viejo de GraphQL** (`cores/vtex.js`, modo `search`): `GET /_v/segment/graphql/v1/?operationName=productSuggestions&extensions={persistedQuery: {sha256Hash: "...", ...}}`,
con el hash de `VTEX_SHA256_HASH`. `normalizeProduct()` toma `items[0].ean`, `commertialOffer.Price` y el precio
de referencia de `unitMultiplier`, igual que `normalizeCatalogProduct()`.

### Scraper de Coto (no-VTEX)

Coto is one of the largest Argentine chains but is **not VTEX** — it uses **Constructor.io** for its product catalog and an ATG (Oracle Commerce) BFF for promotions. It also prices **per store** (its product API returns a `price[]` array keyed by store code), unlike the 7 VTEX merchants which price chain-wide. Design doc: `docs/superpowers/specs/2026-07-23-coto-scraper-design.md` (Laravel repo).

**Product source — Constructor.io (`cores/constructor.js`):**
- Public browse API, no auth, no Cloudflare: `GET https://ac.cnstrc.com/browse/group_id/{groupId}?key=key_r6xzz4IAoTWcipni&num_results_per_page=...&page=...`.
- `collectLeafGroupIds(rootGroupId='categoria')` walks the category tree recursively. The API only exposes **one level of children per response**, so discovering a node's children requires browsing that node itself; nodes with no children are leaves.
- Each leaf is paged independently and capped at `MAX_WINDOW = 10000` results (Constructor.io's browse window limit) — a leaf that hits the cap logs a warning (possible truncation); the fix is splitting that leaf into finer subcategories, not raising the cap.
- `normalizeConstructorItem(rawItem)` → `{ean, name, brand, image, images, categories, link, storePrices: [{code, price, listPrice, isAvailable}]}`, or `null` if `data.product_main_ean` is missing (same discard-without-EAN rule as `normalizeProduct()` for VTEX). `storePrices` is built from `data.price[]` (one row per store, `store` → `code`) via `resolveStorePrice()`.
- **`formatPrice` anomaly guard (`resolveStorePrice()`):** Coto's `formatPrice` field is occasionally garbage for a given store (e.g. `formatPrice=29.05` next to `listPrice=2495`). The guard only trusts `formatPrice` when it is **≥ 10% of `listPrice`** (`ANOMALY_RATIO = 0.1`); otherwise it falls back to `listPrice` as the effective price. This only catches "discounts" deeper than 90%, which in practice are always data errors — it never collapses a legitimate discount.

**`scrapers/coto.js`** is a thin wrapper: `getCotoMainProducts()` calls `scrapeConstructorMerchant({merchantName:'Coto', onProductFound: saveCotoProduct})`. `mode` is ignored — Constructor.io always walks the full category tree.

**`saveCotoProduct(product, merchantId)` (`cores/saveHandlers.js`) — follower with per-store dimension:**
1. **Follower gate:** if `product.ean` isn't in the `products` master catalog, return `{saved:false, reason:'not_in_master'}` (same as every non-Disco VTEX scraper — Coto never creates products).
2. **Store bootstrap by code:** for each `storePrices[].code`, `ensureStore()` upserts a `merchant_stores` row keyed by `(merchantId, externalReference=code)`, with `name=code` as a placeholder until enrichment. An in-memory `Map` (module-level, per run) caches `code → merchantStoreId` so the same store isn't upserted once per product. On an existing row, the upsert's `update` clause is `{}` — it deliberately never overwrites name/address/coords that were enriched later by `stores:sync coto` or the backoffice.
3. **Headline = MIN:** picks the cheapest available store row (falls back to all rows if none are marked available) and upserts `merchant_products` with that `price`/`listPrice`, `isAvailable = OR` across stores, plus a `price_history` snapshot — computed directly in Node so there's never a window where the headline is stale relative to the store rows. Laravel's `merchant-store-prices:rollup` (scheduled, idempotent) exists as a reconciler, not the primary path, for Coto.
4. **Per-store prices:** upserts one `merchant_store_prices` row per `(merchantProductId, merchantStoreId)` with that store's `price`/`listPrice`/`isAvailable`/`lastCheckedAt`.
5. Wrapped in try/catch → `{saved:false, reason:'exception'}` on any failure, same contract as the other save handlers.

**Promotions — `scrapers/promos/coto.js` (`getCotoPromotions()`), PULL provider:**
- Source: `GET https://www.coto.com.ar/rest/model/atg/actors/cProfileActor/getPromocionesMulticanal?enviroment=ag&pushSite=CotoDigital` — a plain GET, no session/`_dynSessConf` needed.
- The response's `result` has **two arrays that share the exact same item shape**: `promocionesDigitales` and `promocionesSucursalesFisicas`; the only semantic difference is the `isDigital` flag. Both are flattened together and normalized.
- `vigenciaDesde`/`vigenciaHasta` are always `null` in practice — the AI infers real validity from the free-text `diasVigencia`/`dias` fields instead, which are passed through untouched.
- `normalizeCotoPromotion()` prefixes `external_id` with `d`/`f` (`coto-d-{id}` / `coto-f-{id}`) because digital and physical ids are **not a shared namespace** (both start at low ranges and would otherwise collide).
- Consumed on the Laravel side by `App\Services\PromotionsProviders\CotoService` (`AbstractScrapperPullProvider`, same pattern as Jumbo/Patagonia) via `GET /api/promotions/coto`. Never throws to the caller — returns `{success:false, ...}` on error.

**Stores enrichment — `scrapers/stores/coto_stores.js`: real parser (not the legacy no-op).** `getCotoStores()` fetches `GET https://www.coto.com.ar/sucursales/` — a public, server-rendered landing with **9 `<table>`** (CABA + 8 regions: ZONA NORTE, ZONA SUR, ZONA OESTE, COSTA ATLÁNTICA, SANTA FE, ENTRE RIOS, NEUQUÉN, MENDOZA), ~121 stores. The pure parsing step is `parseCotoStores(html)` (cheerio, no network — the unit-testable part), which walks every `table tr` whose first `<td>` is numeric and maps columns `Suc/Sucursal/Direccion/Tipo/Lunes a Jueves/Viernes/Sabado/Domingo/Teléfono` to the store contract:
- `external_reference`: **zero-padded to 3 digits** (`String(suc).padStart(3,'0')`) — critical, see below.
- `name`: the "Sucursal"/barrio column (e.g. `ABASTO`).
- `address`, `city` (segment after the last `" - "` in the address), `province` (nearest preceding `h1`-`h4` heading via `prevAll` — the CABA table has no such sibling heading, so its `province` is `null`; the other 8 tables get their region name).
- `store_type`: always `'physical'` — the "Tipo" column is a HIPER/SUPER merchandising badge image, unrelated to the physical/online enum.
- `phone`, `opening_hours` (`{lun_jue, vie, sab, dom}`, stored as JSON via `MerchantStore`'s `array` cast).
- **`latitude`/`longitude` are `null` — documented gap.** This page has NO coordinates. The authenticated SPA "elegí tu sucursal" selector (`cCarritoActor/getSucursales` or similar ATG actor) likely has them, but requires deep interaction with the purchase flow / login — out of scope here (no guessing at authenticated ATG endpoints). The geo "nearest store" feature is therefore **not available for Coto** until coordinates are sourced some other way (login capture or geocoding the address).
- **⚠️ Padding is make-or-break:** the product price API (Constructor.io → `saveCotoProduct`) delivers store codes zero-padded to 3 digits (`"091"`, `"060"`, `"092"`, `"220"`) and already bootstrapped `merchant_stores` rows keyed on those padded codes. The `/sucursales/` table shows codes **unpadded** (`"91"`, `"60"`, `"92"`, `"220"` unchanged since it's already 3 digits). `StoreSyncService` upserts by `(merchant_id, external_reference)`, so without the `padStart(3,'0')` this scraper would create orphan rows instead of enriching the priced ones.
- Fixture: `scraper-tests/fixtures/coto-sucursales.html` (real page snapshot, 121 stores); unit test `scraper-tests/coto-stores.test.js` (`npm run test:coto-unit`) asserts the ABASTO row (`"91"` → `"091"`, name, address, phone, `opening_hours.lun_jue`, `latitude === null`) and that every `external_reference` is padded (`/^\d{3,}$/`).
- `getCotoStores()` never throws to the caller — network/parse errors return `{success:false, source:'coto', total:0, stores:[], error, timestamp}`.

**HARD RULE — Prisma is `generate`-only for the Coto mirror tables, never `migrate`:** `MerchantStore` and `MerchantStorePrice` in `prisma/schema.prisma` are a **mirror** of tables Laravel already owns and migrates (`merchant_stores`, `merchant_store_prices` — part of the per-store-pricing foundation). After editing `prisma/schema.prisma` to add or change these models, run **only** `npx prisma generate` (regenerates the client). **Never** run `npx prisma migrate dev/deploy` against them — Laravel's migrations are the single source of truth for this schema; running a Prisma migration from Node would create a parallel migration history and drift the schema out from under Laravel. Field names/types in the mirror must match the Laravel migration exactly.

### Scraper de promociones de Banco Santander (Puppeteer + BFF)

`scrapers/promos/santander.js` (`getSantanderPromotions()`), PULL provider consumido por Laravel vía `GET /api/promotions/santander` (`App\Services\PromotionsProviders\SantanderService`).

- **Fuente:** la SPA https://www.santander.com.ar/personas/beneficios consume un BFF JSON público del mismo origen: `GET /bff-benefits/brands?limit=500&page=N` (lista de ~644 marcas, `{items, totalItems}`) y `GET /bff-benefits/brands/{id}` (las publicaciones/beneficios vigentes de esa marca, ya estructurados: `customerDiscount`, `topAmount`, flags booleanos por día + `fullWeek`, `interestFreeFees` + `initialQuote`/`finalQuote`, `startDatePublication`/`endDatePublication`, `legal`/`additionalText` en HTML, `benefitType`/`paymentType`/`paymentMethod`).
- **⚠️ Por qué Puppeteer y no axios:** el WAF de Santander hace fingerprinting TLS y deja COLGADA (sin respuesta, ni siquiera error HTTP) cualquier conexión que no venga de un browser real — curl y axios quedan en timeout. El scraper abre la página UNA vez con Chromium headless (`puppeteer-core`) y todas las llamadas al BFF se hacen con `fetch()` DENTRO del contexto de la página (`page.evaluate`), mismo origen y mismo TLS. NO scrapea el DOM: el markup (styled-components) cambia por build, el BFF es estable.
- **Chromium:** `puppeteer-core` no descarga browser. En Docker, el Dockerfile instala `chromium` vía apk y setea `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser`; en dev local sin esa env var cae al Chrome instalado (`channel: 'chrome'`).
- **Flujo:** goto beneficios (networkidle2) → probe con reintentos al BFF → paginar brands → detalle por marca con concurrencia 5 y pausa de 100ms entre lotes → normalizar → dedupe por `external_id`. Corrida completa ≈ 90s; el endpoint `/api/promotions/santander` cachea 6h en Redis, y el `ScrapperClient` de Laravel usa timeout 300s para este provider (`SantanderService::clientTimeout()`).
- **Contrato:** `external_id = san-{publicationId}`, `start_date`/`end_date` en `YYYY-MM-DD` (los usa el filtro de overlap mensual de `AbstractScrapperPullProvider`), `dias` en español (flags booleanos; sin flags o `fullWeek` ⇒ los 7 días), HTML de `legal`/`additionalText` limpiado con `stripHtml()` (legales capados a 4000 chars). Nunca lanza al caller: `{success:false, ...}` ante error global; una marca que falla no aborta el lote.
- **Origen:** adaptación de la entrega de Prácticas Profesionalizantes de Thiago Coro (2026-08), que validó la necesidad de browser real; su scraping de DOM por click se reemplazó por el BFF.
- Fixture: `scraper-tests/fixtures/santander-brand.json` (snapshot real del BFF); unit tests `npm run test:santander-unit` (normalización pura, sin red).

### Contrato de fechas (todos los scrapers de promos)

**El objetivo** es que `start_date`/`end_date` salgan siempre como `YYYY-MM-DD` o `null` — nunca
el formato crudo de la fuente — y que un valor que no matchea el formato esperado se emita
`null`, no una fecha adivinada. Cada scraper es responsable de convertir el suyo (`dd/mm/yyyy` en
Galicia, timestamps ISO en Santander, etc.); Laravel tiene un parser estricto (`StrictDate`) como
**segunda línea de defensa**, no como la primera — confiar en que Laravel arregla lo que el
scraper mandó mal es el mismo error que llevó al bug de `Carbon::parse()` con `m/d/Y` (ver
"Promotion tiers, benefits and eligibility" en el CLAUDE.md del repo Laravel).

**No todos lo cumplen todavía.** Excepciones conocidas:
- `scrapers/promos/patagonia.js` — `toIso()` arma la fecha con `Date.UTC` sin verificar que el
  resultado sea el mismo día/mes/año (sin round-trip): `31/02/2026` sale como `2026-03-03` en vez
  de `null`.
- `scrapers/promos/mercadopago.js` — la vigencia viene como texto sin año ("del 3 al 9 de
  octubre"); cuando el texto no trae "de 2026", el año se **infiere** del año en curso.

Galicia (`ddmmyyyyToIso()`, con round-trip) es la referencia para los scrapers nuevos.

### Scraper de promociones de Banco Galicia (BFF de "Quiero!")

`scrapers/promos/galicia.js` (`getGaliciaPromotions()`), PULL provider consumido por Laravel vía
`GET /api/promotions/galicia`. Relevamiento completo:
`docs/superpowers/research/2026-09-23-fuentes-de-promos/galicia.md` (repo Laravel).

- **Fuente:** el buscador de promociones de www.galicia.ar es un iframe a beneficios.galicia.ar
  (Next.js), que consume un BFF JSON público **sin token**: `GET
  {BFF}/personalizacion/v1/promociones/catalogo?page=&pageSize=` (listado, sólo sirve para saber
  qué ids hay) y `GET {BFF}/catalogo/v1/promociones/idPromocion/{id}` (detalle: %, cuotas, tope
  con periodicidad, compra mínima, días, tarjetas, segmento y legales). `BFF =
  https://loyalty.bff.bancogalicia.com.ar/api/portal`.
- **Agrupado de segmentos:** Galicia publica **un id por segmento** de la misma promo (Masivo
  20%, Eminent 25% del mismo comercio y vigencia). `groupKey()` agrupa los detalles que comparten
  comercio, vigencia, días, tarjetas, QR/NFC y tipo de beneficio (ahorro/cuotas) en un registro
  con `segments: [...]`, que la IA convierte en niveles del lado de Laravel (ver "Promotion
  tiers" en el CLAUDE.md del repo Laravel). Dos detalles del MISMO segmento (mismo
  `modeloAtencion`+`haberes`) dentro del mismo grupo **no** se fusionan: el segundo abre su
  propio grupo (la clave incluye su id), porque son dos promos distintas que casualmente
  comparten comercio y vigencia.
- **`external_id`** = `gal-` + sha1(groupKey) recortado a 12 chars — estable entre corridas y
  ante cualquier orden de llegada de los detalles (no depende de qué id sea "el primero").
- **Concurrencia y reintentos:** `GALICIA_DETAIL_CONCURRENCY` (default 3) controla cuántos
  detalles se piden en paralelo; cada detalle reintenta 2 veces (1 s / 3 s) ante 429/503, 5xx o
  error de red. Lo que sigue fallando se reintenta **una vez más en una pasada final en serie**
  (300 ms entre ids). El listado reintenta una vez (1 s).
- **Un detalle que no llegó no muta una promo agrupada.** El `external_id` no depende de qué
  segmentos hay adentro del grupo: publicar Elten sin su Eminent cambiaría la huella (la IA la
  re-normaliza, pago), le faltaría un nivel un día y al siguiente volvería a cambiar. Por eso, por
  cada id que falla también en la pasada final, `dropGroupsOfFailed()` saca **todos** los grupos de
  su comercio (`m{idMarca}` del listado) o, si la promo es por categoría (sin `idMarca`), todos los
  grupos por categoría (`c…`). Esas promos no salen esa corrida y la staging de Laravel conserva la
  fila de ayer (ausente no es cambiada). El resultado trae `failed_details` (cuántos), `failed_ids`
  y `dropped_groups`.
- **Falla fuerte ante bloqueo, nunca "0 promos":** `parseBffResponse()` separa tres casos. Un
  **403** o un cuerpo que no parsea como JSON (challenge HTML) lanza `GaliciaBlockedError`: no se
  reintenta, los demás workers dejan de tomar ids (flag `aborted`) y la corrida termina con
  `{success:false, blocked:true}` en vez de devolver una lista vacía como si no hubiera promos. Un
  **429 o 503** lanza `GaliciaTransientError`: el BFF pide aire, se reintenta con backoff y, si no
  se recupera, el detalle cuenta como fallido (en el listado, la corrida falla con
  `blocked:false`). Cualquier otro status no-2xx es un error común. Si el BFF empieza a exigir un challenge
  real (WAF tipo F5), el plan B es el mismo patrón que Santander: `fetch()` desde
  `puppeteer-core` dentro del contexto de una página real — no se agregó acá porque a
  2026-09-23 el BFF responde directo sin browser.
- Fixture: `scraper-tests/fixtures/galicia-promos.json` (snapshot real del BFF, 2026-09-23);
  unit tests `scraper-tests/galicia-promos.test.js` (agrupado, fechas, ids y manejo de fallas con
  un `get` inyectado — sin red).

### El route de promos no cachea fallas

`routes/dataRoutes.js` (`GET /api/promotions/:source`): si el scraper devuelve `{success:
false}` (bloqueado, excepción atrapada, lo que sea), el handler responde **502**, no 200. Con
200, `cacheMiddleware` guarda esa falla 6 horas en Redis y Laravel la lee como "0 promos" hasta
que expire el cache — un scraper caído se ve igual que un comercio sin promos ese día. 502 nunca
se cachea (`cacheMiddleware` sólo cachea `res.statusCode` en `[200,300)`) y hace fallar el pull
del lado de Laravel de inmediato, en vez de silenciarlo.

### Scrapers de Dia y Vea (promociones + sucursales)

Los 7 scrapers VTEX de **productos** (incluidos `diaonline.js` y `vea.js`) no cambian.
Lo que se agregó son las **promociones** de ambas cadenas y las **sucursales** de Dia.

**`scrapers/promos/dia.js` (`getDiaPromotions()`)** — API pública de VTEX, sin browser.
Recorre las colecciones de oferta (`fq=productClusterIds:567` "Todas las Ofertas" y `7220`
"Hasta 2x1") y deriva una promoción por cada:
- **Teaser** (fuente primaria): `commertialOffer.Teasers` es el motor de promociones de VTEX
  y ya entrega la promo estructurada — nombre (`2x1`, `3x2`, `6x4`, `2do al 70%`) y
  `MinimumQuantity`. ⚠️ Los teasers vienen serializados con los nombres internos de .NET
  (`<Name>k__BackingField`), no `Name`; `teaserField()` soporta ambas formas.
- **`clusterHighlights`** (fallback): sólo para los productos sin teaser, igual que `jumbo_promos.js`.

Cada promoción viaja con `sample_products` que **incluyen el EAN** (a diferencia de
`jumbo_promos.js`), lo que permite cruzarlas con el catálogo. ⚠️ Los `clusterHighlights` de Dia
son heterogéneos: hay clusters de catalogación ("Productos Sin Gluten") mezclados con ofertas
reales. Se emiten igual, marcados con `promotion_kind` (`teaser` | `cluster`); el gate de
`needs_review` del normalizador decide qué se publica. **No agregar una lista negra de nombres**:
sería adivinar, y es justo la clase de heurística frágil que este scraper vino a reemplazar.

⚠️ **Esperable: TODAS las promos de Dia caen en `needs_review` con motivo `dates_defaulted`.**
El catálogo de VTEX no expone vigencia ni de las colecciones ni de los teasers, así que este
scraper emite `start_date`/`end_date` en null (a propósito — no inventa fechas) y el normalizador
las completa por defecto marcando la promo para revisión. Medido en la primera corrida de
producción (2026-08-21): 15 de 16 normalizadas, las 15 con `is_active=0` esperando revisión
manual en el backoffice; la 16ª ("Exclusivo Online", un cluster de canal sin descuento) ni
siquiera se pudo normalizar. **No es un bug del scraper ni del normalizador**: es el gate
funcionando — sin vigencia real, la promo no se publica sola. Vea no tiene este problema porque
su Master Data sí trae `dateStart`/`dateEnd`, y por eso sus 26 se publicaron directo.
Si alguna vez se quiere publicar Dia automáticamente, hay que conseguir la vigencia en origen;
**no alcanza con relajar el gate**.
⚠️ Los ids de colección son de Dia y pueden cambiar si rearman la landing; una colección que
devuelve 0 productos **loguea un warning explícito** en vez de fallar en silencio.

**`scrapers/promos/vea.js` (`getVeaPromotions()`)** — API pública, sin browser.
Fuente: Master Data de Cencosud, entidad `JN`, documento `bankDiscount`
(`/api/dataentities/JN/documents/bankDiscount?_fields=value,id&an=jumboargentina`).
- El campo `value` es un **string con JSON adentro** (doble parse → `unwrapDocument()`).
- El documento es **compartido por Vea, Disco y Jumbo**; cada promo declara sus sitios en
  `websites[]` (con repetidos) y se filtra por `veaargentina`. **El mismo endpoint serviría
  para Disco y Jumbo**: hoy `jumbo_promos.js` deriva las promos de Jumbo de `clusterHighlights`
  (títulos crípticos tipo `VEA_visaymastercardtmpinst3x-mensualfam47sar`); migrarlo a esta
  fuente es una mejora pendiente.
- ⚠️ **`discount` y `discountText` NO son campos independientes**: son el número y su sufijo,
  y la tarjeta los muestra **concatenados**. `discount=3.00` + `"cuotas sin interés"` es
  *"3 cuotas sin interés"* — **no** un 3% de descuento; `discount=12` con texto de cuotas son
  DOCE CUOTAS. Por eso se emite `etiqueta` (concatenación fiel, vía `buildDiscountLabel()`) y
  `descuento_porcentaje`/`cuotas` sólo se completan cuando el sufijo desambigua
  (`splitDiscount()`); ante un sufijo mixto (`"25% y 3 cuotas sin interés"`) quedan en null a
  propósito. Un null explícito es preferible a un número con la unidad equivocada.
- ⚠️ **`days` (1=lunes … 6=sábado) no es totalmente confiable**: lo carga un operador en el
  backoffice de Cencosud. Hay al menos una promo cuyo `info` dice "Viernes, Sábado y Domingo"
  mientras `days` trae sólo `["5","6"]`, y el valor domingo no aparece nunca en el dataset. Por
  eso se emiten `dias` (derivado) **y** `info`/`legales` crudos: la fuente de verdad ante la
  ambigüedad es el texto libre, que es lo que normaliza la IA (mismo criterio que `diasVigencia`
  en Coto).
- El dataset **no trae id por promoción** (el `id` es del documento contenedor, igual para las
  193). `buildExternalId()` hashea (sha1, 12 chars) los campos invariantes — bancos, descuento,
  cuotas, fechas, días — excluyendo `priority` y `stores`, que varían con la operación diaria.
  Sin eso, cada corrida duplicaría la cola de normalización (y el gasto en tokens de IA).
- Se descartan las promos ya vencidas (el dataset arrastra registros de 2022/2023); el recorte
  fino por mes lo hace igual `AbstractScrapperPullProvider`.

**`scrapers/stores/dia_stores.js` (`getDiaStores()`)** — **requiere Chromium**.
Fuente: Master Data de VTEX, entidad `TI`, la misma que alimenta `/tiendas`.
- ⚠️ **Por qué Puppeteer y no axios**: la ruta vive bajo `_v/private/` y responde **404** a
  cualquier request sin la cookie de sesión VTEX que se emite al cargar la página. Se abre la
  landing una vez con `puppeteer-core` y la llamada se hace con `fetch()` **dentro** del
  contexto de la página — mismo patrón y misma razón que `scrapers/promos/santander.js`.
  No se scrapea el DOM (las clases del tema son hashes por build).
- ⚠️ El header **`rest-range: resources=0-4999` no es opcional**: sin él la entidad responde
  404, no un 206 truncado como sería intuitivo. Junto con el parámetro `_where` son las dos
  condiciones para que conteste.
- ⚠️ **`geo` es un string `"longitud,latitud"` — longitud PRIMERO**, al revés que la entidad
  `NT` de Jumbo (que usa `"lat,lng"`). Verificado contra el bounding box de Argentina sobre los
  970 activos: 965 caen dentro leyendo `[lon,lat]` y **0** leyendo `[lat,lon]`. Invertirlo manda
  todas las sucursales al Índico. Hay un test unitario que lo fija.
- Cobertura: ~1000 registros / ~970 activos en 8 provincias (CABA, Buenos Aires, Entre Ríos,
  Salta, Corrientes, Santa Fe, Córdoba, Jujuy), ~100% con coordenadas. Se descartan inactivos,
  `bajaTemporal` y los que no tienen geo (`geo:"0"`), igual que `jumbo_stores.js`.
- **Horarios**: el Master Data trae `hours` en null para casi todos los registros. La API pública
  `/api/checkout/pub/pickup-points` sí los tiene (741 con horarios) **pero sólo cubre AMBA** (745
  puntos, todos a <50 km de CABA) y no comparte identificador con el Master Data, así que no se
  puede cruzar de forma confiable. Queda como gap documentado, no como bug.

**Consumo desde Laravel**: `App\Services\PromotionsProviders\DiaService` y `VeaService`
(`AbstractScrapperPullProvider`, mismo patrón que Jumbo/Coto) vía `GET /api/promotions/{dia,vea}`;
sucursales vía `GET /api/stores/dia` → `StoreSyncService` (`php artisan stores:sync dia`).

**Tests**: `npm run test:dia-vea-unit` (normalización pura, con fixtures reales, sin red).

**Origen**: adaptación de la entrega de Prácticas Profesionalizantes de **Joaquin Alodi** (2026-08),
que identificó las tres fuentes (`/especial-ofertas`, `/descuentos-del-dia`, `/tiendas`) y validó
que las dos últimas no son server-rendered. Su implementación scrapeaba el DOM con Puppeteer y
reconstruía las tarjetas por heurística de líneas de texto; acá se reemplazó por las APIs/Master
Data que alimentan esas mismas páginas — mismo criterio que se aplicó a la entrega de Santander.

### Promociones bancarias de Cencosud — core compartido (Vea, Disco, Jumbo)

`cores/cencosudBankDiscounts.js` es la única implementación; `scrapers/promos/{vea,disco,jumbo_promos}.js`
son wrappers finos que sólo aportan la parametrización de cadena.

- **Fuente:** un ÚNICO documento de Master Data, entidad `JN`, documento `bankDiscount`, en la cuenta
  `jumboargentina`. Es público, sin browser y sin cookies:
  `GET /api/dataentities/JN/documents/bankDiscount?_fields=value,id&an=jumboargentina`
- ⚠️ **`an=jumboargentina` es obligatorio.** Con `an=discoargentina` o sin `an`, el endpoint responde
  **200 con cuerpo vacío** (0 bytes) — un fallo que parece "no hay promos" en vez de un error.
- Los tres hosts (disco / vea / jumbo.com.ar) devuelven el documento **idéntico byte a byte** (mismo sha1).
  Cambiar de host no cambia nada; lo que separa a cada cadena es `websites[]`.
- Reparto actual (193 promos): `discoargentina` 146, `jumboargentina` 138, `jumboargentinaio` 149,
  `veaargentina` 144. Vigentes al 2026-08-29: Disco 33, Jumbo 35, Vea 25.
- ⚠️ **El match de sitio es exacto, no `includes()`.** El dataset tiene filas con `disco`/`vea` "pelados"
  además del nombre completo; un `includes('disco')` arrastraría promos ajenas.
- **Jumbo mira DOS sitios** (`jumboargentina` + `jumboargentinaio`) y deduplica por `external_id`.
  ⚠️ Contraintuitivo y ya medido: eso **no** produce duplicados, porque cada promo es UNA fila que enumera
  sus sitios, así que el filtro la deja pasar una sola vez (35 antes y después de deduplicar). El dedupe
  sirve por otro motivo: el documento trae 193 filas y sólo 191 fingerprints distintos.
  **No "arreglar" esto recorriendo sitio por sitio** — se rompería lo que hoy funciona.

**Por qué Jumbo migró a esta fuente.** `jumbo_promos.js` derivaba sus promos de `clusterHighlights`, que en
Cencosud son códigos internos de campaña (`VEA_visaymastercardtmpinst3x-mensualfam47sar`,
`DISCO_rpacpay20off-28al02sar`): ilegibles para el usuario y para el normalizador de IA. Ahora salen del
mismo `bankDiscount`, con banco, días, cuotas y vigencia reales.

**Los dos gotchas semánticos:**
- `discount` + `discountText` son **número y sufijo de una misma etiqueta**, se muestran concatenados.
  `discount=12` con texto "Cuotas sin interés" son DOCE CUOTAS, no un 12%. Se emite `etiqueta` ya armada y
  `descuento_porcentaje`/`cuotas` quedan en `null` ante sufijos mixtos. Caso real que lo justifica:
  `100` + `"mil $"` es un reintegro de $100.000 — ni 100%, ni 100 cuotas.
- ⚠️ **El inicio y el fin NO se leen igual.** Cencosud graba en hora argentina y usa la medianoche como
  frontera entre dos días, pero la nombra distinto según el extremo. `toEndDate` lee en ART (23:59 ART del
  31/08 ⇒ `2026-08-31`, el día que cierra). `toStartDate` hace lo mismo **pero suma un día cuando la hora
  cae entre las 23:00 y las 23:59 ART**, porque ahí Cencosud nombra el día que ABRE. Sin esa regla, 25 de
  las 193 filas arrancaban un día antes y 2 cruzaban el borde de mes, ensanchando hacia atrás el filtro de
  overlap de `AbstractScrapperPullProvider`.
- **Riesgo latente anotado:** el fingerprint de `buildExternalId` ignora `info` y `legals`. Las 2 colisiones
  reales del documento difieren justo en esos campos, pero son pares cruzados entre cadenas y el filtro por
  sitio corre antes, así que hoy no se pierde nada (0 colapsos en las tres cadenas). Dos promos de la MISMA
  cadena que sólo difieran en el texto libre sí colapsarían. No se agregó `info` al fingerprint porque un
  retoque de texto del operador generaría un `external_id` nuevo y una fila duplicada en la cola.

### Sucursales de Disco

`scrapers/stores/disco_stores.js` — VTEX Master Data entidad **`NT`**, la misma que usa Jumbo, pública y sin
browser: `GET /api/dataentities/NT/search?_fields=...&an=discoargentina`

- 76 registros, **71 activos, 100% con coordenadas**, en 4 provincias.
- ⚠️ **El header `REST-Range: resources=0-999` es obligatorio.** Sin él la API devuelve **15 filas** (el
  `rest-content-range` de la respuesta lo canta: `resources 0-15/76`). No falla de forma evidente: parece
  simplemente que Disco tiene 15 sucursales.
- ⚠️ **`geocoordinates` es un string `"latitud,longitud"` — latitud PRIMERO.** Igual que la entidad NT de
  Jumbo y **al revés que el campo `geo` de Dia**. Verificado contra el bounding box de Argentina: 76/76 caen
  dentro leyendo `[lat,lon]` y **0/76** leyendo `[lon,lat]`. Hay un test que lo fija.
- ⚠️ **`external_reference` debe ser `id` (uuid).** `SellerName` colisiona: 76 sucursales comparten sólo 43
  valores (`jumboargentinad028` cubre 7 tiendas).
- `city`/`street`/`number`/`neighborhood` existen en el esquema pero vienen **null en 76/76**. La ciudad se
  parsea de `address`, que es un compuesto `"CALLE - CP - CIUDAD - PROVINCIA"`; sale en 75/76 y el que no
  matchea queda en `null`, no adivinado.
- `postalCode` es inconsistente entre filas (`"7605"` contra `"B1846dgh"`): viaja como string tal cual.
- Callejones sin salida ya recorridos: la ruta privada `_v/private/store-services/masterdata-info/*` que usa
  Dia responde 404 en Disco; `pickup-points` devuelve 0; y `/sucursales` **no** es server-rendered.

### Scrapers de Josimar (comercio nuevo)

Cadena del sur del GBA (Lanús, Lomas de Zamora, Avellaneda, Quilmes, Berazategui, Monte Grande, Barracas),
VTEX, cuenta `arjosimarprod`. Es el **9º comercio** del proyecto y entra como **FOLLOWER** (el master sigue
siendo Disco).

**Productos — `scrapers/josimar.js`:** ~5.700 productos, **100% con EAN** (la PK del catálogo es
`products.ean`). De una muestra de 1.798 EANs, **846 (47%) ya están en el catálogo master**, así que Josimar
suma un competidor real en ~2.700 productos.
- Recorre con el core compartido `cores/vtexCatalog.js` (que nació de este archivo), **sin canal y sin filtro de
  disponibilidad**: su catálogo no es compartido, y recorrer también lo que está sin stock permite escribir
  `is_available = false`. Sin `sc` la API usa el canal por defecto del host (el 5).
- ⚠️ **Hay que recorrer por categoría.** `_from > 2500` devuelve **HTTP 400**, así que no se puede paginar el
  catálogo entero de corrido. El árbol está en `/api/catalog_system/pub/category/tree/3` (14 departamentos).
- ⚠️ El recorrido propio que tenía antes bajaba a las subcategorías con el id suelto (`C:/17/`), que da 0: el
  día que Almacén (2.260) pasara la ventana, se habría perdido entero sin aviso. El core usa el path completo.

⚠️ **Precio: Josimar NO es estrictamente chain-wide.** Se publica el precio de la consulta sin `sc` y hoy
**no** participa de `merchant_store_prices`, pero eso es una decisión pendiente, no un hecho de la fuente:
medido sobre 140 EANs × 5 sales channels, **2 (1,4%) difieren entre sucursales**, con spreads del 15-25%
(Coca Cola 2.25L $4.930 en tres tiendas contra $5.800 en dos). Peor: el precio sin `sc` resultó **el más
barato de los cinco**, o sea que en esas dos tiendas el cliente paga más de lo publicado — misma clase de
problema que BUG-073 en Coto, a escala mucho menor. Migrarlo a per-store cuesta 5× requests, mirror Prisma,
banda de plausibilidad y selector para 5 de las 9 sucursales: es una decisión de producto.

**Sucursales — `scrapers/stores/josimar_stores.js`:**
`GET /api/checkout/pub/pickup-points?geoCoordinates=lon;lat`
- 11 puntos (9 sucursales físicas), con dirección, CP, coordenadas y horarios por día.
- ⚠️ El parámetro es **obligatorio** (sin él, 400) y va **`"lon;lat"`**. Hay que consultar con una coordenada
  del **GBA sur**: desde Mar del Plata, Rosario o Córdoba devuelve **0**.
- ⚠️ Acá `address.geoCoordinates` es un **array `[longitud, latitud]`** — longitud primero, distinto del
  string `"lat,lon"` de la entidad NT de Disco/Jumbo. Dos formatos opuestos conviven en este repo: revisar
  siempre cuál aplica.
- `/files/storeSelectorConfig-master.json` agrega **teléfono** y sales channel de las 5 tiendas que venden
  online.

**Promociones — `scrapers/promos/josimar.js`:** Josimar **no tiene promos bancarias** (su Master Data da 403 y
no participa del documento de Cencosud) y **`commertialOffer.Teasers` viene vacío en los 5.691 productos**,
así que el enfoque de `dia.js` no sirve. Las promos salen de `clusterHighlights` (61 colecciones sobre 2.529
productos) y del diccionario público `/files/flagsConfig-master.json` (173 flags).
- ⚠️ Muchas etiquetas de `flagsConfig` vienen **codificadas**: `porcentaje--100--2--1---POWERADE 2X1:2X1.png`.
  El título legible es lo que va tras el último `---` y antes del `:`.
- **La vigencia se parsea del título** (`"CERVEZAS 20% OFF 14-07 a 08-09"`) para emitir fechas reales y evitar
  que caigan todas en `needs_review` por `dates_defaulted`, que es lo que le pasa a Dia. El año no está en el
  dato: se elige la ubicación más cercana a la fecha de referencia, lo que resuelve bien los rangos que cruzan
  diciembre-enero. **Límite conocido:** una etiqueta rancia de exactamente un año cuyo rango contenga al día
  de hoy sale como vigente. No es resoluble desde el título; ver el comentario de `parseValidity`.
- `JosimarService` sube `clientTimeout()` a 180 s: la corrida en frío mide ~50 s (expande cada colección a
  sus productos) y contra el default de 60 s quedaba muy poco margen.

**Origen de Disco y Josimar:** adaptación de la entrega de Prácticas Profesionalizantes de **Nazareno
Leguizamón** (2026-08), que identificó ambos sitios y sus URLs. Su implementación scrapeaba el DOM con
Puppeteer y selectores comodín que no matcheaban nada (0 sucursales de Disco, 0 ofertas de Josimar); acá se
reemplazó por las APIs JSON que alimentan esas mismas páginas — mismo criterio que con Santander y Dia/Vea.

## Important Patterns

### Adding a New Scraper

1. Si es VTEX: agregar la entrada a `VTEX_MERCHANTS` en `cores/vtexProducts.js` (dominio y canal de
   `GET https://<dominio>/api/segments` → `channel`), medirlo con `npm run catalog:dry -- <clave>` y crear
   `scrapers/new-store.js`:
```javascript
import { scrapeVtexProducts } from '../cores/vtexProducts.js';

export async function getNewStoreMainProducts(mode = 'categories') {
  return scrapeVtexProducts('newstore', mode);
}
```
   Antes de decidir el filtro de disponibilidad, comparar el total del catálogo con y sin
   `fq=isAvailablePerSalesChannel_{canal}:1`: si el catálogo es compartido con otra cadena (Cencosud), el
   filtro es obligatorio.

2. Add to `scripts/populate-db.js` SCRAPERS object
3. Add npm script to `package.json`: `"scrape:newstore": "node scripts/populate-db.js newstore"`
4. Add route handler in `routes/scraperRoutes.js`

### Modifying Database Schema

1. Edit `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name descriptive_name`
3. Prisma client auto-regenerates

**Important:** The schema uses MySQL-specific types (`@db.VarChar`, `@db.Decimal`, etc.). Migration from PostgreSQL (Supabase) is documented in schema comments.

### Redis Caching

The `middlewares/cacheMiddleware.js` provides Redis caching via Upstash:
- Cache key format: `cache:${req.originalUrl}`
- TTL: 5 minutes (300s)
- Used on product query endpoints to reduce DB load

### Authentication

Scraper endpoints require bearer token authentication (`middlewares/authMiddleware.js`):
- Token set via `API_TOKEN` env variable
- Header: `Authorization: Bearer <API_TOKEN>`

## Environment Variables

Required variables (see `.env.template`):
- `DATABASE_URL`: MySQL connection string for Prisma
- `VTEX_SHA256_HASH`: VTEX GraphQL hash (extract via `scripts/extractVtexHash.js`)
- `API_TOKEN`: Bearer token for scraper endpoints
- `UPSTASH_REDIS_REST_URL`: Redis cache URL
- `UPSTASH_REDIS_REST_TOKEN`: Redis auth token

Optional:
- `PORT`: Server port (default: 3000)
- `SLACK_WEBHOOK_URL`: Slack notifications for scraper events
- `WEBHOOK_URL`: Generic webhook for scraper lifecycle events
- `JOB_RETENTION_HOURS`: Job cleanup interval (default: 24)
- `PRODUCT_EANS`: JSON array of EAN codes for `eans` mode

## Known Issues & Quirks

- **VTEX hash expiration:** sólo afecta al modo `search`. Si ese modo falla con `PersistedQueryNotFound`, re-extract hash (see `COMO_OBTENER_HASH.md`)
- **ListPrice bug:** VTEX's `ListPrice` field is incorrect (82x multiplier). Use `PriceWithoutDiscount` instead (handled in `normalizeProduct()`)
- **EAN filtering:** Products without EAN codes are discarded (`normalizeProduct` returns `null`)
- **Master catalog dependency:** Follower scrapers silently skip products not in master catalog (check logs for `not_in_master` entries)
- **Bank scrapers:** New bank-related scrapers in `scrapers/banks/` are in development (see `cores/modo.js` and `cores/saveHandlers.js` `saveBankModo` stub)
