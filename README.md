# 4.8 million products, explored like a notebook, in a tab

Lattice Grid over DuckDB-Wasm, reading the Open Food Facts product database (4,826,073 products, one 85 MB Parquet file)
by HTTP byte range. Filter by country, brand and Nutri-Score, search names and brands, sort, page, read the header
histograms, see the biggest categories with their medians, and watch the Nutri-Score chart follow. Every one of those is
a DuckDB query, and the page shows the SQL it ran with its timing.

## Loading

The first visit has three slow steps: the query engine (about 34 MB of WebAssembly, a fifth of that on the wire), starting it, and reading the opening scope (French products with a Nutri-Score) from the Parquet file. The page says what it is doing instead of showing blank space (`src/loading.js`, `src/duckdb.js`, copied from the SaaS demo):

1. **A status line in the static HTML**: spinner, one plain-English sentence and a progress bar, on screen from first paint: "Downloading the query engine (about 34 MB, first visit only): n of m MB", "Starting the engine", "Reading France products with a Nutri-Score (n of m MB)", then "Listing the countries for the picker".
2. **Real byte counts.** The engine's download is reported by DuckDB-Wasm itself; Parquet reads are counted by a small worker wrapper over a `BroadcastChannel`. The expected total comes from `parquet_metadata()` (the footer, fetched anyway).
3. **Every panel has a loading state** (`slot()`): the tiles, the chart, the category grid and the product grid are covered until their first answer.
4. The country list (a scan of one column across the file) is read after the first rows are up, so it is off the critical path.

Measured with Chrome's DevTools protocol, cache disabled, network throttled to 20 Mbps / 40 ms latency for the page and the DuckDB worker alike: first paint 0.5 s, first rows on screen about 10.7 s, tiles, chart and categories about 31 s, fully ready about 35 s (data from data.latticegrid.dev, engine from jsDelivr).

## Run it

```
npm install
npm run build-data   # downloads food.parquet (~8 GB) and writes data/off-products.parquet
npm start            # then open the printed URL with ?data=local
npm run verify       # headless Chrome; every figure checked against DuckDB in Node
```

No framework, no bundler, no build step: `index.html`, `main.js`, `src/*.js`, `styles.css`. The page reads its data from
`DATA_URL` in `src/config.js` (data.latticegrid.dev); `?data=local` reads `data/off-products.parquet`.
The Parquet file is never committed. See [`data/README.md`](data/README.md) for the source, licence and row counts.

Data: **Open Food Facts contributors**, ODbL (database) and DbCL (contents); data derived from it is shared under the ODbL.
Demo code: MIT. Lattice Grid is commercial software; the key in `src/licence.js` is bound to `toclocoinc.github.io`.

Built with [Lattice Grid](https://www.latticegrid.dev).
