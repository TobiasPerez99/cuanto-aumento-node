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
npm run scrape:all         # Run all scrapers sequentially

# Test scrapers (without DB writes)
npm run test:disco
npm run test:carrefour
# etc...
```

### VTEX Hash Management
When Carrefour/VTEX scrapers fail with GraphQL errors, the sha256Hash likely expired:
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

Scrapers support two modes (passed as argument):
- **`categories` (default):** Scrapes broad product categories from `cores/categories.js` (50 products per category)
- **`eans`:** Scrapes specific EAN codes from `PRODUCT_EANS` env variable (1 product per EAN)

Example: `npm run scrape:disco categories` or via API: `POST /api/scrape/disco` with body `{ "mode": "eans" }`

### Core Scraping Flow

1. **Scraper files** (`scrapers/*.js`): Thin wrappers that call `scrapeVtexMerchant()` with config
2. **VTEX core** (`cores/vtex.js`): Generic VTEX GraphQL scraper
   - Fetches products via `fetchVtexProducts()`
   - Normalizes VTEX response to standard format via `normalizeProduct()`
   - Calls `onProductFound` callback for each product
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
- `POST /api/scrape/all` - Run all scrapers
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

### VTEX Integration

VTEX stores require a **sha256Hash** for GraphQL queries (set via `VTEX_SHA256_HASH` env var). This hash:
- Is extracted from browser DevTools (see `COMO_OBTENER_HASH.md`)
- Changes periodically (expires every few weeks/months)
- Used in `cores/vtex.js` to construct GraphQL queries

**VTEX Query Structure:**
```
GET /_v/segment/graphql/v1/?operationName=productSuggestions&extensions={persistedQuery: {sha256Hash: "...", ...}}
```

The `normalizeProduct()` function handles VTEX-specific quirks:
- Extracts EAN from `items[0].ean`
- Uses `seller.commertialOffer.Price` (not `priceRange` which can be incorrect)
- Calculates reference prices (e.g., price per liter) from `unitMultiplier`

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

## Important Patterns

### Adding a New Scraper

1. Create `scrapers/new-store.js`:
```javascript
import { scrapeVtexMerchant } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js'; // or saveMasterProduct if new master

export async function getNewStoreMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexMerchant({
    merchantName: 'NewStore',
    baseUrl: 'https://www.newstore.com.ar',
    categories: useEans ? productEans : DETAILED_CATEGORIES,
    onProductFound: saveFollowerProduct, // or saveMasterProduct
    count: useEans ? 1 : 50
  });
}
```

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

- **VTEX hash expiration:** When scrapers fail with GraphQL errors, re-extract hash (see `COMO_OBTENER_HASH.md`)
- **ListPrice bug:** VTEX's `ListPrice` field is incorrect (82x multiplier). Use `PriceWithoutDiscount` instead (handled in `normalizeProduct()`)
- **EAN filtering:** Products without EAN codes are discarded (`normalizeProduct` returns `null`)
- **Master catalog dependency:** Follower scrapers silently skip products not in master catalog (check logs for `not_in_master` entries)
- **Bank scrapers:** New bank-related scrapers in `scrapers/banks/` are in development (see `cores/modo.js` and `cores/saveHandlers.js` `saveBankModo` stub)
