# 4.8 million products, explored like a notebook, in a tab

Lattice Grid over DuckDB-Wasm, reading the Open Food Facts product database (4,826,073 products, one 85 MB Parquet file)
by HTTP byte range. Filter by country, brand and Nutri-Score, search names and brands, sort, page, read the header
histograms, see the biggest categories with their medians, and watch the Nutri-Score chart follow. Every one of those is
a DuckDB query, and the page shows the SQL it ran with its timing.

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
