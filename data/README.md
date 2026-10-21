# Data

The page reads one Parquet file that is **not in this repository**. `npm run build-data`
(`tools/build-parquet.mjs`, Node 22 and `@duckdb/node-api`) writes it from public sources only; the release box
uploads it to `https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-food-facts/off-products.parquet`
(the one constant in `src/config.js`). `?data=local` reads `data/off-products.parquet` through `tools/serve.mjs` instead.

## Source, licence, attribution

- **Open Food Facts product database**, the `food.parquet` export:
  <https://huggingface.co/datasets/openfoodfacts/product-database> (about 8 GB, 7,971,858,382 bytes when built).
- Licence: the database is under the **Open Database Licence (ODbL) 1.0**
  (<https://opendatacommons.org/licenses/odbl/1-0/>); its individual contents are under the
  **Database Contents Licence (DbCL) 1.0** (<https://opendatacommons.org/licenses/dbcl/1-0/>). Product images are not used.
- Attribution: **Open Food Facts contributors**, <https://world.openfoodfacts.org>. The page footer says so and links both licences.
- **Derived data is shared under the ODbL**, with the same attribution: the extract this build writes, and anything
  built from it, is a derivative database.

## What the build does

1. Downloads `food.parquet` into `.cache/` (gitignored), or reads it over HTTP with `--remote`, or from `--source <path>`.
2. Extracts nine columns, with the same SQL as the `open-food-facts-duckdb` notebook in lattice-grid-notebooks: `code`,
   `product_name` (first language entry), `brand` (first of the list), `country` and `category` (first tag, `en:` removed),
   `nutri_score` (A to E), and `sugar_g`, `salt_g`, `energy_kcal` per 100 g from the `nutriments` list.
3. Sets values that cannot be real to NULL: sugar or salt outside 0 to 100 g, energy outside 0 to 900 kcal, a Nutri-Score
   that is not a to e, and a category tag that starts with a digit (a quantity typed into the category box).
4. Writes one file: **zstd, row groups of about 100,000 rows (`ROW_GROUP_SIZE 100000`; DuckDB aligns them to 100,352),
   sorted by country, category, code**, so a filter on a country reads a few row groups, not all 49.

## Measured (the build of 2026-10-21)

| | |
|---|---|
| `SELECT count(*)` | **4,826,073** rows |
| File size | **89,259,111 bytes (85.1 MB)** |
| Row groups | 49 |
| Products with a Nutri-Score (A to E) | 1,424,011 (A 207,750, B 163,829, C 297,436, D 356,735, E 398,261) |
| With a name / brand / country / category | 4,542,573 / 3,092,688 / 4,803,216 / 1,900,753 |
| With sugar / salt / energy | 3,243,666 / 3,027,023 / 3,465,752 |
| Distinct countries / categories / brands | 314 / 39,720 / 476,098 |

`data/facts.json` (gitignored) is rewritten by every build with these figures. The Open Food Facts database changes daily,
so a rebuild gives somewhat different numbers; the page reads its totals from the file.
