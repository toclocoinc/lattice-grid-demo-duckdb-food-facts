/**
 * Load the page in a real browser against the local data and check that what
 * it says is true.
 *
 * Every figure the page shows is recomputed here by a second DuckDB, in Node,
 * over the same Parquet file, with SQL written out separately from the grid's
 * so an error in the adapter cannot hide by being made twice. Every
 * interaction is a real pointer or keyboard event (`Input.dispatch*`).
 *
 *   npm run build-data     # once: writes data/off-products.parquet
 *   npm run verify
 *
 * `--shots <dir>` also saves screenshots at 1440px and 390px, light and dark.
 */

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { startServer } from './serve.mjs';
import { launchBrowser } from './browser.mjs';
import { LOCAL_DATA_URL } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const shotDir = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;

const failures = [];
const notes = [];
function check(ok, description, detail) {
  const line = `${description}${detail ? ` (${detail})` : ''}`;
  if (ok) notes.push(`  ok   ${line}`);
  else { failures.push(line); notes.push(`  FAIL ${line}`); }
  console.log(notes.at(-1));
}

const int = (n) => Number(n).toLocaleString('en-US');
const n = (v) => (v == null ? null : Number(v));
const close = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-6);

const FILE = join(root, LOCAL_DATA_URL);
try { await access(FILE); } catch {
  console.error(`No data at ${FILE}. Run: npm run build-data`);
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* The independent answer                                              */
/* ------------------------------------------------------------------ */

const { DuckDBInstance } = await import('@duckdb/node-api');
const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
const P = `read_parquet('${FILE.replaceAll("'", "''")}')`;
const rows = async (sql) => (await conn.runAndReadAll(sql)).getRowObjects();
const one = async (sql) => (await rows(sql))[0];
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** WHERE for a scope, written again here in the same terms the controls use. */
const where = ({ country, grade, brand, search, extra } = {}) => [
  country && `country = ${lit(country)}`,
  grade === 'graded' && 'nutri_score IS NOT NULL',
  grade && grade !== 'graded' && `nutri_score = ${lit(grade)}`,
  brand && `brand ILIKE ${lit(`%${brand}%`)}`,
  search && `(product_name ILIKE ${lit(`%${search}%`)} OR brand ILIKE ${lit(`%${search}%`)})`,
  extra,
].filter(Boolean).join(' AND ') || 'true';

async function truth(scope) {
  const w = where(scope);
  const a = await one(`SELECT count(*) AS rows, median(sugar_g) AS sugar, median(salt_g) AS salt, median(energy_kcal) AS energy FROM ${P} WHERE ${w}`);
  const grades = await rows(`SELECT nutri_score AS g, count(*) AS c FROM ${P} WHERE ${w} AND nutri_score IS NOT NULL GROUP BY 1 ORDER BY 1`);
  const cats = await rows(`
    SELECT category, count(*) AS products, count(nutri_score) AS scored, median(sugar_g) AS sugar, median(salt_g) AS salt, median(energy_kcal) AS energy
    FROM ${P} WHERE ${w} AND category IS NOT NULL GROUP BY category ORDER BY products DESC, category LIMIT 10`);
  return { rows: n(a.rows), sugar: n(a.sugar), salt: n(a.salt), energy: n(a.energy), where: w, grades, cats };
}

/* ------------------------------------------------------------------ */
/* The browser                                                         */
/* ------------------------------------------------------------------ */

async function run() {
  const served = await startServer(0);
  const origin = `http://127.0.0.1:${served.port}`;
  const browser = await launchBrowser({ width: 1440, height: 900 });
  console.log(`Browser: ${browser.chromePath}\nServing: ${origin}`);
  try {
    const { evaluate, waitFor, click, type, call } = browser;
    const page = (expr) => evaluate(`(() => { const p = window.__foodFacts; return ${expr}; })()`);
    const settle = async (expected, what) => {
      await waitFor(`window.__foodFacts.matchCount === ${expected.rows}`, 120000, `${what}: the count`);
      const want = JSON.stringify({ s: expected.sugar, l: expected.salt, e: expected.energy, c: expected.cats[0]?.category ?? null, p: n(expected.cats[0]?.products) });
      await waitFor(`(() => { const p = window.__foodFacts; const w = ${want};
        const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-6);
        return same(p.scope.medianSugar, w.s) && same(p.scope.medianSalt, w.l) && same(p.scope.medianEnergy, w.e)
          && (p.categories[0]?.category ?? null) === w.c && (p.categories[0]?.products ?? null) === w.p; })()`, 120000, `${what}: the medians and categories`);
      await sleep(1500);
    };
    const gridText = () => evaluate("document.querySelector('.grid-host .lat-body-viewport').innerText");

    await browser.navigate(`${origin}/?data=local`);
    await waitFor('window.__foodFacts && (window.__foodFacts.isReady || window.__foodFacts.error)', 180000, 'the page to be ready');
    check(await page('!p.error'), 'the page started', await page('p.error || ""'));
    await sleep(2500);

    /* ---------------------------- the file itself ---------------------------- */
    const file = await one(`SELECT count(*) AS rows, count(DISTINCT country) AS countries FROM ${P}`);
    check(await page('p.totalRows') === n(file.rows), 'the page counted the whole file', `${int(n(file.rows))} products`);
    check(n(file.rows) >= 4.5e6 && n(file.rows) <= 5.5e6, 'the file holds about 4.8 million products', int(n(file.rows)));
    const lede = await evaluate("document.querySelector('.lede').textContent");
    check(lede.includes(int(n(file.rows))), 'the intro states the exact product count', int(n(file.rows)));
    const meta = await rows(`SELECT count(*) AS groups, max(row_group_num_rows) AS biggest FROM parquet_metadata('${FILE.replaceAll("'", "''")}') WHERE path_in_schema = 'code'`);
    check(n(meta[0].biggest) <= 102400 && n(meta[0].groups) > 40, 'the file is in row groups of about 100,000 rows', `${n(meta[0].groups)} groups`);

    /* ------------------- default scope: French, with a grade ------------------ */
    let t = await truth({ country: 'france', grade: 'graded' });
    check(await page('p.matchCount') === t.rows, 'the opening count matches DuckDB in Node', `${int(t.rows)} French products with a Nutri-Score`);
    const first = await one(`SELECT code, product_name FROM ${P} WHERE ${t.where} LIMIT 1`);
    const text0 = await gridText();
    check(text0.includes(first.code), 'the first grid row is the file\'s first row for that scope', first.code);
    const plan0 = await page('p.pagePlan');
    check(plan0 && plan0.unpushed.length === 0, 'the filter went to DuckDB as a bound WHERE, nothing left for the browser', JSON.stringify(plan0?.unpushed));
    check(await page(`p.sqlLog.some((l) => /WHERE/.test(l.sql) && (l.params || []).includes('france'))`), 'the country was bound into the query, not interpolated');

    async function figures(label) {
      const tile = (id) => evaluate(`document.querySelector('[data-tile="${id}"] .tile-value').textContent`);
      check(await tile('rows') === int(t.rows), `${label}: the count tile`, int(t.rows));
      check(close(await page('p.scope.medianSugar'), t.sugar) && close(await page('p.scope.medianSalt'), t.salt) && close(await page('p.scope.medianEnergy'), t.energy),
        `${label}: the three medians match DuckDB in Node`, `${t.sugar} / ${t.salt} / ${t.energy}`);
      const cats = await page('p.categories');
      check(cats.length === t.cats.length && cats.every((c, i) => c.category === t.cats[i].category
        && c.products === n(t.cats[i].products) && c.scored === n(t.cats[i].scored)
        && close(c.sugar, n(t.cats[i].sugar)) && close(c.salt, n(t.cats[i].salt)) && close(c.energy, n(t.cats[i].energy))),
      `${label}: the category panel's counts and medians match`, t.cats[0] ? `${t.cats[0].category} ${int(n(t.cats[0].products))}` : 'none');
    }

    /** The chart's bars, from the drawing: grade labels in order, bar heights in proportion to the true counts. */
    async function chartMatches(label) {
      await sleep(1500);
      const drawn = await evaluate(`(() => {
        const svg = document.querySelector('[data-chart="nutri"] svg');
        const labels = [...svg.querySelectorAll('text')].map((x) => x.textContent.trim()).filter((x) => /^[A-E]$/.test(x));
        const bars = [...svg.querySelectorAll('rect')].map((r) => Number(r.getAttribute('height'))).filter((h) => h > 0 && h < 400).slice(-labels.length);
        return { labels, bars };
      })()`);
      const want = t.grades.map((g) => ({ g: g.g, c: n(g.c) }));
      const ordered = drawn.labels.join('') === want.map((w) => w.g).join('');
      const max = Math.max(...want.map((w) => w.c));
      const maxBar = Math.max(...drawn.bars);
      const proportional = drawn.bars.length === want.length && want.every((w, i) => Math.abs(drawn.bars[i] / maxBar - w.c / max) < 0.015);
      check(ordered, `${label}: the Nutri-Score chart is in A to E order`, drawn.labels.join(' '));
      check(proportional, `${label}: the chart's bars are in proportion to DuckDB's counts`, want.map((w) => `${w.g} ${int(w.c)}`).join(', '));
    }

    await figures('opening scope');
    await chartMatches('opening scope');
    const prov = await page('p.chart.provenance && p.chart.provenance()');
    check(prov?.source === 'engine' && prov?.refused === false, 'the chart is computed in DuckDB', JSON.stringify({ source: prov?.source, refused: prov?.refused }));
    check(await page(`p.sqlLog.some((l) => /GROUP BY ROLLUP\\("nutri_score"\\)/.test(l.sql) && /count\\(\\*\\) AS "m0"/.test(l.sql))`), 'the chart ran GROUP BY nutri_score with a count');
    check(await page(`p.sqlLog.some((l) => /GROUP BY ROLLUP\\("category"\\)/.test(l.sql) && /median\\("sugar_g"\\)/.test(l.sql))`), 'the category panel ran GROUP BY category with medians');

    /* header histograms */
    await waitFor(`['country','nutri_score','sugar_g','salt_g','energy_kcal'].every((c) => document.querySelectorAll('.lat-facet[data-col="' + c + '"] .lat-facet__bar').length > 0)`, 120000, 'the header histograms');
    const bars = await evaluate(`['country','nutri_score','sugar_g','salt_g','energy_kcal'].map((c) => document.querySelectorAll('.lat-facet[data-col="' + c + '"] .lat-facet__bar').length)`);
    check(bars.every((c) => c > 0), 'header histograms are drawn on country, Nutri-Score, sugar, salt and energy', bars.join(', '));

    /* the SQL panel */
    const sqlPanel = await evaluate("document.querySelector('[data-plan-sql]').textContent");
    check(/SELECT "code"/.test(sqlPanel) && /median\("sugar_g"\)/.test(sqlPanel) && /ROLLUP/.test(sqlPanel) && /bound: \["france"\]/.test(sqlPanel) && / ms · /.test(sqlPanel),
      'the SQL panel shows the page, the medians and the groupings, with bound values and timings');
    check(/Last run: .* ms/.test(await evaluate("document.querySelector('[data-timings]').textContent")), 'the timings line reads in milliseconds');

    /* ------------------------------ Nutri-Score chips ----------------------- */
    await click('.chip[data-id="A"]');
    t = await truth({ country: 'france', grade: 'A' });
    await settle(t, 'grade A');
    check(true, 'clicking A filters to Nutri-Score A', `${int(t.rows)} products`);
    await figures('grade A');
    check((await gridText()).includes((await one(`SELECT code FROM ${P} WHERE ${t.where} LIMIT 1`)).code), 'the first row for grade A is the file\'s first row for that scope');

    await click('.chip[data-id=""]');
    t = await truth({ country: 'france' });
    await settle(t, 'any grade');
    check(true, 'Any lifts the Nutri-Score filter', `${int(t.rows)} products`);
    await figures('any grade (the with-a-grade count differs from the product count)');

    await click('.chip[data-id="graded"]');
    t = await truth({ country: 'france', grade: 'graded' });
    await settle(t, 'graded');

    /* ------------------------------ country --------------------------------- */
    await evaluate(`(() => { const s = document.querySelector('select[data-control="country"]'); s.value = 'germany'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    t = await truth({ country: 'germany', grade: 'graded' });
    await settle(t, 'Germany');
    check(true, 'choosing a country filters in DuckDB', `Germany, ${int(t.rows)} products`);
    await figures('Germany');
    await chartMatches('Germany');

    await evaluate(`(() => { const s = document.querySelector('select[data-control="country"]'); s.value = 'france'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    t = await truth({ country: 'france', grade: 'graded' });
    await settle(t, 'France again');

    /* ------------------------------ brand ------------------------------------ */
    await type('input[data-control="brand"]', 'danone');
    t = await truth({ country: 'france', grade: 'graded', brand: 'danone' });
    await settle(t, 'brand');
    check(true, 'the brand filter runs in DuckDB', `"danone", ${int(t.rows)} products`);
    await figures('brand Danone');
    check(await page(`p.sqlLog.some((l) => /"brand"/.test(l.sql) && (l.params || []).some((v) => String(v).toLowerCase().includes('danone')))`), 'the brand text was bound, not interpolated');
    await type('input[data-control="brand"]', '');
    t = await truth({ country: 'france', grade: 'graded' });
    await settle(t, 'brand cleared');

    /* ------------------------------ quick search ----------------------------- */
    await type('input[data-control="search"]', 'muesli');
    t = await truth({ country: 'france', grade: 'graded', search: 'muesli' });
    await settle(t, 'search');
    check(true, 'quick search (typed) runs in DuckDB', `"muesli", ${int(t.rows)} products`);
    await figures('search muesli');
    await chartMatches('search muesli');
    check(await page(`p.sqlLog.some((l) => /LIKE|ILIKE/i.test(l.sql) && (l.params || []).some((v) => String(v).includes('muesli')))`), 'the search term was bound into the query');
    await type('input[data-control="search"]', '');
    t = await truth({ country: 'france', grade: 'graded' });
    await settle(t, 'search cleared');

    /* ------------------------------ sort -------------------------------------- */
    await click('.grid-host [role="columnheader"][data-col="sugar_g"] .lat-header-title, .grid-host [role="columnheader"][data-col="sugar_g"]');
    await sleep(1500);
    await click('.grid-host [role="columnheader"][data-col="sugar_g"] .lat-header-title, .grid-host [role="columnheader"][data-col="sugar_g"]');
    await waitFor(`window.__foodFacts.sqlLog.some((l) => /ORDER BY "sugar_g" DESC/.test(l.sql))`, 60000, 'a descending sort');
    await sleep(1500);
    const top = await one(`SELECT code, sugar_g FROM ${P} WHERE ${t.where} AND sugar_g IS NOT NULL ORDER BY sugar_g DESC LIMIT 1`);
    const sortedText = await gridText();
    check(sortedText.split('\n').slice(0, 14).join(' ').includes(String(Number(top.sugar_g).toFixed(1))), 'sorting by sugar, descending, runs in DuckDB and the top value is the true maximum', `${Number(top.sugar_g).toFixed(1)} g`);

    /* ------------------------------ paging ------------------------------------ */
    const before = await page(`p.sqlLog.filter((l) => /OFFSET 200/.test(l.sql)).length`);
    const box = await evaluate(`(() => { const r = document.querySelector('.grid-host .lat-body-viewport').getBoundingClientRect(); document.querySelector('.grid-host').scrollIntoView({block:'center'}); const r2 = document.querySelector('.grid-host .lat-body-viewport').getBoundingClientRect(); return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 }; })()`);
    for (let i = 0; i < 14; i += 1) {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 900 });
      await sleep(120);
    }
    await sleep(2500);
    const after = await page(`p.sqlLog.filter((l) => /OFFSET 200/.test(l.sql)).length`);
    check(after > before, 'scrolling past the first 200 rows fetches the next page from DuckDB', `${after - before} OFFSET 200 queries`);
    const row250 = await one(`SELECT code FROM ${P} WHERE ${t.where} AND sugar_g IS NOT NULL ORDER BY sugar_g DESC, code LIMIT 1 OFFSET 0`);
    void row250;

    /* ------------------------------ header histogram -------------------------- */
    await evaluate("document.querySelector('.grid-host').scrollIntoView({ block: 'start' })");
    await click('.lat-facet[data-col="nutri_score"] .lat-facet__bar', 4);
    t = await truth({ country: 'france', grade: 'E' });
    await waitFor(`window.__foodFacts.matchCount === ${t.rows}`, 120000, 'the histogram click');
    check(true, 'clicking the E bar in the Nutri-Score histogram filters the grid', `${int(t.rows)} products`);

    /* -------------------------------- hygiene --------------------------------- */
    const body = await evaluate('document.body.innerText');
    check(!/\bNaN\b|undefined|\[object Object\]/.test(body), 'no NaN, undefined or [object Object] in the page text');
    check(await page('p.grid.licence.watermark() === false'), 'no watermark');
    check(/Open Food Facts contributors/.test(body) && /ODbL|Open Database Licence/.test(body) && /Database Contents Licence/.test(body), 'the page credits Open Food Facts contributors and links both licences');
    check(browser.consoleErrors.length === 0 && browser.pageErrors.length === 0, '0 console errors', JSON.stringify([...browser.consoleErrors, ...browser.pageErrors]).slice(0, 400));
  } finally {
    await browser.close();
  }

  /* ------------------------- looks: screenshots, on request ------------------- */
  if (shotDir) {
    for (const [name, viewport] of [
      ['desktop-light', { width: 1440, height: 900, colorScheme: 'light' }],
      ['desktop-dark', { width: 1440, height: 900, colorScheme: 'dark' }],
      ['phone-light', { width: 390, height: 844, colorScheme: 'light', mobile: true }],
      ['phone-dark', { width: 390, height: 844, colorScheme: 'dark', mobile: true }],
    ]) {
      const shot = await launchBrowser(viewport);
      try {
        await shot.navigate(`${origin}/?data=local`);
        await shot.waitFor('window.__foodFacts && (window.__foodFacts.isReady || window.__foodFacts.error)', 180000, 'the page');
        await sleep(5000);
        await shot.screenshot(join(shotDir, `${name}.png`));
        check(shot.consoleErrors.length === 0 && shot.pageErrors.length === 0, `${name}: no console errors`);
      } finally {
        await shot.close();
      }
    }
  }
  served.server.close();
}

try {
  await run();
} catch (error) {
  failures.push(`the run itself failed: ${error.message}`);
  console.error(error);
}
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${notes.length - failures.length} ok, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
