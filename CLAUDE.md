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

**Stores enrichment — `scrapers/stores/coto_stores.js`: documented no-op.** `getCotoStores()` always returns `{success:true, source:'coto', total:0, stores:[]}`. This is intentional, not a pending bug:
- The legacy `/sucursales/` page is a dead marketing landing (Pofo template, one sample coordinate) — discarded as a source.
- The real per-store data lives behind the SPA's "elegí tu sucursal" selector XHR, which requires deep interaction with the purchase flow to capture and was **not captured** in the spike; guessing at ATG actor endpoints is explicitly out — earlier attempts returned 500.
- This is not blocking: `saveCotoProduct` already bootstraps `merchant_stores` rows by code (see above), so per-store pricing works from day one. `StoreSyncService::syncMerchant('coto')` can call this endpoint fine; it just has nothing to enrich while it returns an empty list.
- **Enrichment today is manual**, via Filament (`StoresRelationManager` exposes `latitude`/`longitude`/`phone`) — an operator fills in name/address/coordinates per store from public sources (Google Maps, coto.com.ar) after they're bootstrapped by code.
- To revisit: capture the real selector XHR (with the purchase flow active, not just page load) and map it to the same contract as `scrapers/stores/jumbo_stores.js`: `{external_reference, name, address, city, province, postal_code, latitude, longitude, phone, opening_hours}`. `external_reference` **must** be the Coto store code (the same one `saveCotoProduct` already persists) so `StoreSyncService`'s upsert-by-`external_reference` enriches the existing bootstrapped rows instead of creating duplicates.

**HARD RULE — Prisma is `generate`-only for the Coto mirror tables, never `migrate`:** `MerchantStore` and `MerchantStorePrice` in `prisma/schema.prisma` are a **mirror** of tables Laravel already owns and migrates (`merchant_stores`, `merchant_store_prices` — part of the per-store-pricing foundation). After editing `prisma/schema.prisma` to add or change these models, run **only** `npx prisma generate` (regenerates the client). **Never** run `npx prisma migrate dev/deploy` against them — Laravel's migrations are the single source of truth for this schema; running a Prisma migration from Node would create a parallel migration history and drift the schema out from under Laravel. Field names/types in the mirror must match the Laravel migration exactly.

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
