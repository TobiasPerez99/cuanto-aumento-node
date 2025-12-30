# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **price tracking API** for Argentine supermarkets. It scrapes product data from multiple supermarket websites (primarily VTEX-based stores), stores pricing history in MySQL via Prisma, and exposes REST endpoints for price comparisons.

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

1. **Scraper files** (`scrapers/*.js`): Thin wrappers that call `scrapeVtexSupermarket()` with config
2. **VTEX core** (`cores/vtex.js`): Generic VTEX GraphQL scraper
   - Fetches products via `fetchVtexProducts()`
   - Normalizes VTEX response to standard format via `normalizeProduct()`
   - Calls `onProductFound` callback for each product
3. **Save handlers** (`cores/saveHandlers.js`):
   - `saveMasterProduct()`: Upserts into `products`, `supermarket_products`, and `price_history`
   - `saveFollowerProduct()`: Only upserts if EAN exists in `products` table
4. **Database** (`prisma/schema.prisma`):
   - `Product`: Master catalog (keyed by EAN)
   - `Supermarket`: Supermarket directory
   - `SupermarketProduct`: Junction table with current prices
   - `PriceHistory`: Historical price snapshots

### API Routes

**Product endpoints** (`routes/productRoutes.js`):
- `GET /api/products` - Paginated product list with current prices
- `GET /api/products/search?q=...` - Search by name
- `GET /api/products/:ean` - Product detail with price history
- `GET /api/products/:ean/cheapest` - Find cheapest supermarket
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

## Important Patterns

### Adding a New Scraper

1. Create `scrapers/new-store.js`:
```javascript
import { scrapeVtexSupermarket } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js'; // or saveMasterProduct if new master

export async function getNewStoreMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexSupermarket({
    supermarketName: 'NewStore',
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
