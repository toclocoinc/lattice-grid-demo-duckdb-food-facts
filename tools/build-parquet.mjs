/**
 * Build data/off-products.parquet from the Open Food Facts product database.
 *
 * This is a developer tool. The page never runs it: it reads the Parquet file
 * that this writes, with DuckDB-Wasm, over HTTP range requests. The PM re-runs
 * it on the release box and uploads the output to
 * https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-food-facts/
 *
 *   node tools/build-parquet.mjs                    # download food.parquet into .cache/, extract
 *   node tools/build-parquet.mjs --source <path>    # a copy you already have
 *   node tools/build-parquet.mjs --remote           # read the columns it needs over HTTP, no 8 GB file
 *   node tools/build-parquet.mjs --limit 100000     # a quick sample while developing
 *
 * What it does:
 *
 *   1. Gets food.parquet (about 8 GB, 4.8 million products, 100+ columns) from
 *      https://huggingface.co/datasets/openfoodfacts/product-database, unless a
 *      copy is already in .cache/.
 *   2. Reads nine of its columns with DuckDB: the code, the product name, the
 *      first brand, the first country, the first category, the Nutri-Score
 *      grade, and sugar, salt and energy per 100 g pulled out of the
 *      `nutriments` list.
 *   3. Sets values that cannot be real to NULL (more than 100 g of sugar or
 *      salt in 100 g, more than 900 kcal, negative amounts) and a category
 *      whose tag starts with a digit ("1000", "160 g": a quantity typed into
 *      the category box) to NULL, and writes ONE
 *      Parquet file: zstd, row groups of 100,000 rows, sorted by country, then
 *      category, then code.
 *
 * The sort and the row-group size are the point. DuckDB-Wasm reads the file
 * over HTTP and can skip a row group only when its min/max statistics rule it
 * out. Sorted by country then category, a filter on a country, or on a country
 * and a category, touches a few row groups instead of all of them.
 *
 * Nothing is invented: every value is copied from the database or unpacked
 * from it. The extraction SQL is the same as in the lattice-grid-notebooks
 * `open-food-facts-duckdb` notebook.
 */

import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cache = join(root, '.cache');
const outFile = join(root, 'data', 'off-products.parquet');

const SOURCE_URL = 'https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet';
const ROW_GROUP_SIZE = 100000;

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const remote = args.includes('--remote');
const limit = Number(flag('--limit', '0')) || 0;
const sourceArg = flag('--source', '');

const exists = (path) => access(path).then(() => true, () => false);
const q = (text) => text.replaceAll("'", "''");

async function download(url, to) {
  console.log(`Downloading ${url}\n  to ${to} (about 8 GB)`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let seen = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    seen += chunk.length;
    if (seen - lastReport > 500e6) {
      lastReport = seen;
      console.log(`  ${(seen / 1e9).toFixed(1)} GB${total ? ` of ${(total / 1e9).toFixed(1)} GB` : ''}`);
    }
  });
  await pipeline(body, createWriteStream(`${to}.part`));
  await rename(`${to}.part`, to);
}

await mkdir(cache, { recursive: true });
await mkdir(dirname(outFile), { recursive: true });

let source = sourceArg;
if (!source) {
  if (remote) {
    source = SOURCE_URL;
  } else {
    source = join(cache, 'food.parquet');
    if (!(await exists(source))) await download(SOURCE_URL, source);
    else console.log(`Using ${source}`);
  }
}

const { DuckDBInstance } = await import('@duckdb/node-api');
const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
const rows = async (sql) => (await conn.runAndReadAll(sql)).getRowObjects();
if (/^https?:/.test(source)) await conn.run('INSTALL httpfs; LOAD httpfs;');

/** One nutrient's amount per 100 g, as a DOUBLE, from the `nutriments` list. */
const per100g = (name) => `list_filter(nutriments, x -> x.name = '${name}')[1]."100g"`;

const read = `read_parquet('${q(source)}')`;
const tmp = `${outFile}.tmp`;
await rm(tmp, { force: true });

console.log('Extracting and sorting...');
const started = Date.now();
await conn.run(`
  COPY (
    SELECT
      code,
      nullif(trim(product_name[1].text), '') AS product_name,
      nullif(trim(split_part(brands, ',', 1)), '') AS brand,
      replace(countries_tags[1], 'en:', '') AS country,
      CASE WHEN categories_tags[1] NOT LIKE 'en:undefined' AND regexp_matches(replace(categories_tags[1], 'en:', ''), '^[^0-9]')
           THEN replace(categories_tags[1], 'en:', '') END AS category,
      CASE WHEN nutriscore_grade IN ('a', 'b', 'c', 'd', 'e') THEN upper(nutriscore_grade) END AS nutri_score,
      CASE WHEN ${per100g('sugars')} BETWEEN 0 AND 100 THEN round(${per100g('sugars')}::DOUBLE, 1) END::DOUBLE AS sugar_g,
      CASE WHEN ${per100g('salt')} BETWEEN 0 AND 100 THEN round(${per100g('salt')}::DOUBLE, 2) END::DOUBLE AS salt_g,
      CASE WHEN ${per100g('energy-kcal')} BETWEEN 0 AND 900 THEN round(${per100g('energy-kcal')}::DOUBLE, 0) END::DOUBLE AS energy_kcal
    FROM ${limit ? `(SELECT * FROM ${read} LIMIT ${limit})` : read}
    ORDER BY country NULLS LAST, category NULLS LAST, code
  ) TO '${q(tmp)}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP_SIZE}, WRITE_BLOOM_FILTER false)
`);
await rm(outFile, { force: true });
await rename(tmp, outFile);
console.log(`Wrote ${outFile} in ${Math.round((Date.now() - started) / 1000)} s`);

/* The numbers data/README.md quotes, measured on the file just written. */
const out = `read_parquet('${q(outFile)}')`;
const [summary] = await rows(`
  SELECT count(*) AS products, count(product_name) AS with_name, count(brand) AS with_brand,
         count(country) AS with_country, count(category) AS with_category, count(nutri_score) AS with_nutri_score,
         count(sugar_g) AS with_sugar, count(salt_g) AS with_salt, count(energy_kcal) AS with_energy,
         count(DISTINCT country) AS countries, count(DISTINCT category) AS categories, count(DISTINCT brand) AS brands
  FROM ${out}`);
const [meta] = await rows(`SELECT count(*) AS row_groups FROM parquet_metadata('${q(outFile)}') WHERE path_in_schema = 'code'`);
const grades = await rows(`SELECT nutri_score AS grade, count(*) AS products FROM ${out} WHERE nutri_score IS NOT NULL GROUP BY 1 ORDER BY 1`);
const bytes = (await stat(outFile)).size;
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const facts = {
  source: SOURCE_URL,
  built: new Date().toISOString(),
  file: 'off-products.parquet',
  bytes,
  rowGroups: num(meta.row_groups),
  rowGroupSize: ROW_GROUP_SIZE,
  sample: limit || null,
  ...Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, num(v)])),
  grades: Object.fromEntries(grades.map((g) => [g.grade, num(g.products)])),
  sortedBy: ['country', 'category', 'code'],
};
await writeFile(join(root, 'data', 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
console.log(JSON.stringify(facts, null, 2));
console.log(`\n${(bytes / 1048576).toFixed(1)} MB (${bytes} bytes), ${facts.rowGroups} row groups`);
