/**
 * The page: controls, the figures, a chart, a category panel and the grid, all
 * over one Parquet file read by DuckDB-Wasm.
 *
 *   the grid         `duckdbAdapter` + `createPushdownSource`: filter, sort,
 *                    quick search and paging are SQL in DuckDB.
 *   the chart        `createChart` bound to the grid, `aggregate: 'engine'`:
 *                    one `GROUP BY nutri_score` over everything the grid keeps.
 *   the figures      `source.aggregate()` over the grid's own filter.
 *   the categories   `source.aggregate()` grouped by category: counts and
 *                    medians over the whole match.
 *   the histograms   the grid's own header strips, fed by `source.aggregate()`.
 *   the SQL panel    the statements DuckDB actually ran, with their timing.
 *
 * Nothing is reduced from the rows on screen: the grid holds one window of
 * 4.8 million products, and a figure computed from it would be a figure about
 * the window.
 */

import { dataUrl } from './config.js';
import {
  FIELDS, GRADES, DEFAULT_COUNTRY, DEFAULT_GRADE, COUNTRY_CHOICES, TOP_CATEGORIES, COLUMNS, NUMERIC_EDGES,
  fromFile, prettyCountry, prettyCategory, fmt, num,
} from './data.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A group of single-choice buttons. `onPick(id)` fires on a real click. */
function chips(label, options, onPick) {
  const wrap = el('div', 'field');
  wrap.append(el('span', 'field-label', label));
  const row = el('div', 'chips');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);
  const buttons = new Map();
  for (const option of options) {
    const button = el('button', 'chip', option.label);
    button.type = 'button';
    button.dataset.id = option.id;
    button.addEventListener('click', () => onPick(option.id));
    buttons.set(option.id, button);
    row.append(button);
  }
  wrap.append(row);
  const select = (id) => {
    for (const [key, button] of buttons) {
      button.classList.toggle('on', key === id);
      button.setAttribute('aria-pressed', String(key === id));
    }
  };
  return { wrap, select };
}

const GRADE_CHIPS = [
  { id: '', label: 'Any' },
  { id: 'graded', label: 'Graded' },
  ...GRADES.map((g) => ({ id: g, label: g })),
];

export function buildPage({ host, LG, createChart, connection, sqlLog, duckdbVersion }) {
  const FILE = dataUrl();

  const built = {
    isReady: false,
    isSettled: false,
    error: null,
    grid: null,
    source: null,
    adapter: null,
    chart: null,
    chartGrid: null,
    categoryGrid: null,
    state: { country: DEFAULT_COUNTRY, grade: DEFAULT_GRADE, brand: '', quick: '' },
    matchCount: null,
    totalRows: null,
    plan: null,
    pagePlan: null,
    scope: { medianSugar: null, medianSalt: null, medianEnergy: null },
    categories: [],
    gradeCounts: [],
    timings: { page: null, count: null, scope: null, categories: null },
    countries: [],
    duckdbVersion,
    file: FILE,
  };
  const state = built.state;

  /* ---------------------------------------------------------------- theme */

  const root = document.documentElement;
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  if (!root.dataset.theme) root.dataset.theme = dark.matches ? 'dark' : 'light';
  const themeButton = el('button', 'theme-toggle');
  themeButton.type = 'button';
  const paintTheme = () => {
    const now = root.dataset.theme;
    themeButton.textContent = now === 'dark' ? 'Light theme' : 'Dark theme';
    themeButton.setAttribute('aria-pressed', String(now === 'dark'));
    for (const g of [built.grid, built.categoryGrid]) g?.theme?.set?.(now);
  };
  themeButton.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    paintTheme();
  });
  document.querySelector('.masthead')?.append(themeButton);

  /* ---------------------------------------------------------------- frame */

  host.textContent = '';
  const controls = el('section', 'controls');
  controls.setAttribute('aria-label', 'Choose what to look at');
  const tiles = el('section', 'tiles');
  tiles.setAttribute('aria-label', 'Figures for the current selection');
  const chartRow = el('section', 'charts');
  chartRow.setAttribute('aria-label', 'Nutri-Score and categories for the current selection');
  const gridSection = el('section', 'grid-section');
  const gridHost = el('div', 'grid-host');
  gridHost.setAttribute('aria-label', 'Products');
  const planSection = el('details', 'plan');
  planSection.open = true;
  host.append(controls, tiles, chartRow, gridSection, planSection);

  /* ------------------------------------------------------------- controls */

  const countryField = el('label', 'field');
  countryField.append(el('span', 'field-label', 'Country'));
  const countrySelect = el('select');
  countrySelect.dataset.control = 'country';
  countrySelect.append(new Option('All countries', ''));
  countrySelect.addEventListener('change', () => { state.country = countrySelect.value; applyScope(); });
  countryField.append(countrySelect);

  const gradeChips = chips('Nutri-Score', GRADE_CHIPS, (id) => { state.grade = id; applyScope(); });

  const brandField = el('label', 'field');
  brandField.append(el('span', 'field-label', 'Brand contains'));
  const brand = el('input', 'search');
  brand.type = 'search';
  brand.dataset.control = 'brand';
  brand.placeholder = 'e.g. Danone';
  brand.autocomplete = 'off';
  let brandTimer = 0;
  brand.addEventListener('input', () => {
    clearTimeout(brandTimer);
    brandTimer = setTimeout(() => { state.brand = brand.value.trim(); applyScope(); }, 350);
  });
  brandField.append(brand);

  const searchField = el('label', 'field');
  searchField.append(el('span', 'field-label', 'Search products and brands'));
  const search = el('input', 'search');
  search.type = 'search';
  search.dataset.control = 'search';
  search.placeholder = 'e.g. muesli';
  search.autocomplete = 'off';
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.quick = search.value.trim(); applyScope(); }, 350);
  });
  searchField.append(search);

  const rowA = el('div', 'controls-row');
  rowA.append(countryField, gradeChips.wrap, brandField, searchField);
  controls.append(rowA);

  /* ---------------------------------------------------------------- tiles */

  const tileValues = {};
  const makeTile = (id, label, hint) => {
    const tile = el('div', 'tile');
    tile.dataset.tile = id;
    const value = el('div', 'tile-value', '—');
    tile.append(el('div', 'tile-label', label), value, el('div', 'tile-hint', hint));
    tileValues[id] = value;
    tiles.append(tile);
  };
  makeTile('rows', 'Products matching', 'counted by DuckDB');
  makeTile('sugar', 'Median sugar, g per 100 g', 'over every matching product');
  makeTile('salt', 'Median salt, g per 100 g', 'over every matching product');
  makeTile('energy', 'Median energy, kcal per 100 g', 'over every matching product');

  const paintTiles = () => {
    tileValues.rows.textContent = fmt.int(built.matchCount);
    tileValues.sugar.textContent = fmt.one(built.scope.medianSugar);
    tileValues.salt.textContent = fmt.two(built.scope.medianSalt);
    tileValues.energy.textContent = fmt.int(built.scope.medianEnergy);
  };

  /* --------------------------------------------------------------- panels */

  const chartBox = el('div', 'chart-box');
  chartBox.dataset.chart = 'nutri';
  const categoryBox = el('div', 'category-box');
  categoryBox.dataset.panel = 'categories';
  const categoryHead = el('div', 'panel-head');
  categoryHead.append(el('h2', null, 'Biggest categories'));
  const categoryNote = el('p', 'panel-note');
  categoryNote.dataset.categoryNote = '';
  categoryHead.append(categoryNote);
  const categoryGridHost = el('div', 'category-grid');
  categoryGridHost.setAttribute('aria-label', 'Biggest categories in the selection');
  categoryBox.append(categoryHead, categoryGridHost);
  chartRow.append(chartBox, categoryBox);

  /* ------------------------------------------------------------ the filter */

  /** The grid's filter, from the controls. Header filters the visitor adds replace it, and vice versa. */
  function scopeTree() {
    const conditions = [];
    /* Exact matches: the values are the file's own, and a case-folded `LOWER(country) = ...`
       cannot be answered from a row group's min and max, where a plain `country = ?` can. */
    if (state.country) conditions.push({ col: 'country', op: 'eq', value: state.country, caseSensitive: true });
    if (state.grade === 'graded') conditions.push({ col: 'nutri_score', op: 'notBlank' });
    else if (state.grade) conditions.push({ col: 'nutri_score', op: 'eq', value: state.grade, caseSensitive: true });
    if (state.brand) conditions.push({ col: 'brand', op: 'contains', value: state.brand });
    if (conditions.length === 0) return null;
    return conditions.length === 1 ? conditions[0] : { op: 'and', conditions };
  }

  function paintControls() {
    gradeChips.select(state.grade);
    countrySelect.value = state.country;
  }

  function applyScope() {
    paintControls();
    built.grid?.filters.set(scopeTree());
    built.grid?.filters.quick(state.quick);
  }

  /* ---------------------------------------------------------- the grid */

  const request = (filters, groupBy, quick = '') => ({ filters, sort: [], range: null, groupBy, quick });
  const realGroups = (groups) => (groups ?? []).filter((g) => !g.grouping?.[0]);

  function makeSource() {
    const adapter = LG.duckdbAdapter({
      connection,
      from: fromFile(FILE),
      fields: FIELDS,
      quickColumns: ['product_name', 'brand'],
    });
    const source = LG.createPushdownSource({
      adapter,
      compute: LG,
      pageSize: 200,
      aggregates: { default: 'engine-if-identical' },
    });
    return { adapter, source };
  }

  function mountGrid() {
    const { adapter, source } = makeSource();
    built.adapter = adapter;
    built.source = source;

    const grid = LG.createGrid(gridHost, {
      rowKey: 'code',
      theme: root.dataset.theme,
      columns: COLUMNS,
      source,
      toolPanel: { side: 'right', panels: ['filters', 'columns'] },
      showTotalInHeader: true,
      facets: { enabled: true, collapsed: false, height: 40 },
    });
    built.grid = grid;

    const tree = scopeTree();
    if (tree) grid.filters.set(tree);
    if (state.quick) grid.filters.quick(state.quick);

    /*
     * The rows query is where the match count comes from: the adapter asks for
     * it in the same dispatch as the page. Wrapping the adapter's own execute
     * is how the page learns the filter changed, whoever changed it.
     */
    const inner = adapter.execute.bind(adapter);
    let lastSignature = null;
    adapter.execute = async (query, req) => {
      const started = performance.now();
      const result = await inner(query, req);
      if (!query.groupBy?.length) {
        built.timings.page = Math.round(performance.now() - started);
        if (typeof result.total === 'number') built.matchCount = result.total;
        built.plan = source.lastPlan?.() ?? null;
        built.pagePlan = built.plan;
      }
      const signature = JSON.stringify([query.filters ?? null, query.quick ?? '']);
      if (signature !== lastSignature) {
        lastSignature = signature;
        void refreshScope(query.filters ?? null, query.quick ?? '');
      }
      paintTiles();
      renderPlan();
      return result;
    };

    /* The chart is a viewer of this grid: its filter, its source. */
    try {
      built.chart = createChart({
        grid,
        container: chartBox,
        type: 'bar',
        x: 'nutri_score',
        y: { col: 'code', fn: 'count' },
        aggregate: 'engine',
        legend: false,
        title: 'Products by Nutri-Score',
        subtitle: 'Counted by DuckDB over every product the grid is filtered to',
        axis: { x: 'Nutri-Score grade', y: 'Products' },
      });
    } catch (error) {
      chartBox.append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[food facts demo] chart', error);
    }
    return grid;
  }

  /* -------------------------------------------------- whole-selection queries */

  let scopeSequence = 0;
  async function refreshScope(filters, quick) {
    const turn = ++scopeSequence;
    const source = built.source;
    const started = performance.now();
    try {
      const [headline, byCategory] = await Promise.all([
        source.aggregate(request(filters, [], quick), [
          { id: 'sugar', col: 'sugar_g', fn: 'median' },
          { id: 'salt', col: 'salt_g', fn: 'median' },
          { id: 'energy', col: 'energy_kcal', fn: 'median' },
        ]),
        source.aggregate(request(filters, ['category'], quick), [
          { id: 'products', col: 'code', fn: 'count' },
          { id: 'scored', col: 'nutri_score', fn: 'countValues' },
          { id: 'sugar', col: 'sugar_g', fn: 'median' },
          { id: 'salt', col: 'salt_g', fn: 'median' },
          { id: 'energy', col: 'energy_kcal', fn: 'median' },
        ]),
      ]);
      if (turn !== scopeSequence) return;
      built.timings.scope = Math.round(performance.now() - started);
      const values = headline.values ?? {};
      built.scope = { medianSugar: num(values.sugar), medianSalt: num(values.salt), medianEnergy: num(values.energy) };
      built.aggregateProvenance = {
        engine: (headline.engine ?? []).map((a) => `${a.fn}(${a.col})`),
        client: (headline.client ?? []).map((a) => `${a.fn}(${a.col})`),
      };
      built.categories = realGroups(byCategory.groups)
        .filter((g) => g.keys[0] != null)
        .map((g) => ({
          category: String(g.keys[0]),
          name: prettyCategory(g.keys[0]),
          products: num(g.values.products),
          scored: num(g.values.scored),
          sugar: num(g.values.sugar),
          salt: num(g.values.salt),
          energy: num(g.values.energy),
        }))
        .sort((a, b) => b.products - a.products || (a.category < b.category ? -1 : 1))
        .slice(0, TOP_CATEGORIES);
      feedCategories(realGroups(byCategory.groups).length);
      paintTiles();
      renderPlan();
    } catch (error) {
      console.error('[food facts demo] aggregate', error);
      built.error = String(error?.message ?? error);
    }
  }

  const CATEGORY_COLUMNS = [
    { field: 'name', title: 'Category', layout: { width: 235 }, allowGroup: false },
    { field: 'products', title: 'Products', type: 'number', format: { decimals: 0 }, layout: { width: 90 }, allowGroup: false },
    { field: 'scored', title: 'With a grade', type: 'number', format: { decimals: 0 }, layout: { width: 105 }, allowGroup: false },
    { field: 'sugar', title: 'Median sugar', type: 'number', format: { decimals: 1 }, layout: { width: 105 }, allowGroup: false },
    { field: 'salt', title: 'Median salt', type: 'number', format: { decimals: 2 }, layout: { width: 95 }, allowGroup: false },
    { field: 'energy', title: 'Median kcal', type: 'number', format: { decimals: 0 }, layout: { width: 100 }, allowGroup: false },
  ];

  function feedCategories(distinct) {
    categoryNote.textContent = built.categories.length
      ? `The ${built.categories.length} largest of ${fmt.int(distinct)} categories in the selection, grouped by DuckDB, with the median per 100 g.`
      : 'No product in the selection has a category.';
    if (built.categoryGrid) {
      built.categoryGrid.rows.load(built.categories);
      return;
    }
    built.categoryGrid = LG.createGrid(categoryGridHost, {
      rowKey: 'category',
      theme: root.dataset.theme,
      columns: CATEGORY_COLUMNS,
      rows: built.categories,
    });
  }

  /* ----------------------------------------------------------- the plan */

  function latestStatements() {
    const kinds = new Map();
    for (const entry of sqlLog) {
      const kind = entry.sql.startsWith('DESCRIBE') ? 'describe'
        : entry.sql.includes('median(') && entry.sql.includes('GROUP BY ROLLUP') ? 'categories'
          : entry.sql.includes('median(') ? 'medians'
            : entry.sql.includes('GROUP BY ROLLUP') ? (entry.sql.includes('GROUP BY ROLLUP("nutri_score")') && entry.sql.includes('AS "m0"') ? 'chart' : 'histogram')
              : entry.sql.includes('__lattice_total') || entry.sql.includes('__lattice_match') ? 'count'
                : /\bGROUP BY\b/.test(entry.sql) ? 'histogram'
                  : /\bLIMIT\b/.test(entry.sql) ? 'rows' : 'other';
      kinds.set(kind, entry);
    }
    return kinds;
  }

  const planHead = el('summary', 'plan-summary', 'What went to DuckDB');
  const planTimings = el('p', 'plan-timings');
  planTimings.dataset.timings = '';
  const planNote = el('p', 'plan-note');
  planNote.dataset.planNote = '';
  const planPre = el('pre', 'plan-sql');
  planPre.dataset.planSql = '';
  planSection.append(planHead, planTimings, planNote, planPre);

  function renderPlan() {
    const plan = built.plan;
    const statements = latestStatements();
    const block = (title, entry) => {
      if (!entry) return '';
      const sql = entry.sql.replace(/ (FROM|WHERE|GROUP BY|ORDER BY|LIMIT|OFFSET) /g, '\n$1 ');
      const bound = entry.params?.length ? `\n-- bound: ${JSON.stringify(entry.params)}` : '';
      return `-- ${title} · ${fmt.ms(entry.ms)} · ${fmt.int(entry.rows)} rows back\n${sql}${bound}\n\n`;
    };
    planPre.textContent =
      block('the page of products on screen', statements.get('rows'))
      + block('the match count, sent with it', statements.get('count'))
      + block('the medians in the tiles', statements.get('medians'))
      + block('the category panel: GROUP BY category with medians', statements.get('categories'))
      + block('the Nutri-Score chart', statements.get('chart'))
      + block('a header histogram', statements.get('histogram'));
    const parts = [
      ['page of rows', statements.get('rows')],
      ['count', statements.get('count')],
      ['medians', statements.get('medians')],
      ['categories', statements.get('categories')],
      ['chart', statements.get('chart')],
    ].filter(([, entry]) => entry);
    planTimings.textContent = parts.length
      ? `Last run: ${parts.map(([label, entry]) => `${label} ${fmt.ms(entry.ms)}`).join(' · ')}`
      : '';
    if (plan) {
      const unpushed = plan.unpushed ?? [];
      planNote.textContent = unpushed.length === 0
        ? 'Filter, sort, quick search and paging all ran in DuckDB; nothing was left for the browser to do.'
        : `Left for the browser: ${unpushed.join(', ')}.`;
    }
  }

  /* -------------------------------------------------------------- start */

  async function loadCountries() {
    const result = await connection.query(
      `SELECT country, count(*) AS n FROM ${fromFile(FILE)} WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC, country LIMIT ${COUNTRY_CHOICES}`,
    );
    built.countries = result.toArray().map((r) => String(r.toJSON().country));
    for (const name of built.countries) countrySelect.append(new Option(prettyCountry(name), name));
    countrySelect.value = state.country;
  }

  paintControls();
  gridSection.append(gridHost);
  built.ready = (async () => {
    await loadCountries();
    mountGrid();
    paintTheme();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !(built.grid.rows.count() > 0 && built.matchCount != null && built.categories.length > 0)) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (built.matchCount == null) throw new Error('the first window of rows never arrived');
    built.totalRows = num((await connection.query(`SELECT count(*) AS n FROM ${fromFile(FILE)}`)).toArray()[0].toJSON().n);
    const total = document.querySelector('#row-total');
    if (total) total.textContent = fmt.int(built.totalRows);
    built.isReady = true;
    built.isSettled = true;
  })();

  built.destroy = () => { built.chart?.destroy?.(); built.grid?.destroy?.(); built.categoryGrid?.destroy?.(); };
  return built;
}
