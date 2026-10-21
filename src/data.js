/**
 * What the data is, and how the grid should read it.
 *
 * The Open Food Facts product database, reduced by tools/build-parquet.mjs to
 * one row per product and nine columns, sorted by country and then category.
 * Every column here exists in that file; nothing is computed in the page that
 * the engine could compute instead.
 */

/** Columns the adapter selects. Naming them keeps a page fetch to the column chunks it needs. */
export const FIELDS = [
  'code', 'product_name', 'brand', 'country', 'category', 'nutri_score', 'sugar_g', 'salt_g', 'energy_kcal',
];

/** Nutri-Score runs from the best grade to the worst; the chart and the chips keep that order. */
export const GRADES = ['A', 'B', 'C', 'D', 'E'];

/** The scope the page opens on: French products that carry a Nutri-Score. */
export const DEFAULT_COUNTRY = 'france';
export const DEFAULT_GRADE = 'graded';

/** How many countries the picker lists, most products first. */
export const COUNTRY_CHOICES = 40;
/** How many categories the category panel lists. */
export const TOP_CATEGORIES = 10;

/** The whole file as a FROM expression. */
export const fromFile = (url) => `read_parquet('${url.replaceAll("'", "''")}')`;

/** A slug such as `united-states` as a reader would say it. */
export const prettyCountry = (slug) => String(slug).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
export const prettyCategory = (slug) => {
  const text = String(slug).replaceAll('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const noGroup = { allowGroup: false };

/**
 * The grid's columns.
 *
 * Every filter here is one the DuckDB adapter pushes, so the whole filter tree
 * is a bound WHERE and `lastPlan().unpushed` stays empty. `allowGroup: false`
 * because the grid is a window onto 4.8 million products: grouping is offered
 * by the category panel, computed by DuckDB over the whole match.
 */
export const COLUMNS = [
  { field: 'code', title: 'Barcode', filter: { type: 'text' }, layout: { width: 120 }, facet: false, ...noGroup },
  { field: 'product_name', title: 'Product', filter: { type: 'text' }, layout: { width: 250 }, facet: false, ...noGroup },
  { field: 'brand', title: 'Brand', filter: { type: 'text' }, layout: { width: 150 }, facet: false, ...noGroup },
  { field: 'country', title: 'Country', filter: { type: 'set' }, layout: { width: 130 }, ...noGroup },
  { field: 'category', title: 'Category', filter: { type: 'text' }, layout: { width: 200 }, facet: false, ...noGroup },
  {
    field: 'nutri_score', title: 'Nutri-Score', filter: { type: 'set' }, layout: { width: 140 }, ...noGroup,
    cell: {
      decoration: 'pill',
      variant: {
        when: [
          { op: 'eq', value: 'A', use: 'success' },
          { op: 'eq', value: 'B', use: 'success' },
          { op: 'eq', value: 'C', use: 'warning' },
          { op: 'eq', value: 'D', use: 'warning' },
          { op: 'eq', value: 'E', use: 'danger' },
        ],
        default: 'none',
      },
    },
  },
  {
    field: 'sugar_g', title: 'Sugar g/100 g', type: 'number', filter: { type: 'number' },
    format: { decimals: 1 }, layout: { width: 120 }, ...noGroup,
  },
  {
    field: 'salt_g', title: 'Salt g/100 g', type: 'number', filter: { type: 'number' },
    format: { decimals: 2 }, layout: { width: 110 }, ...noGroup,
  },
  {
    field: 'energy_kcal', title: 'Energy kcal/100 g', type: 'number', filter: { type: 'number' },
    format: { decimals: 0 }, layout: { width: 140 }, ...noGroup,
  },
];

/**
 * The bars of a numeric column's header histogram. Fixed, not derived from the
 * data, so the bars do not move under the pointer as the filter changes.
 * Salt is in uneven steps because nearly every product is under 3 g.
 */
const steps = (from, to, by) => {
  const out = [];
  for (let v = from; v < to - 1e-9; v += by) out.push(Math.round(v * 100) / 100);
  return out;
};
export const NUMERIC_EDGES = {
  sugar_g: [...steps(0, 100, 5), 100.0001],
  salt_g: [0, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 100.0001],
  energy_kcal: [...steps(0, 900, 50), 900.0001],
};

export const fmt = {
  int: (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US')),
  one: (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })),
  two: (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
  ms: (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`),
  compact: (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} million`;
    return v.toLocaleString('en-US');
  },
};

/** A DuckDB `count(*)` or `sum` arrives as a BigInt; everything downstream wants a number. */
export const num = (value) => (typeof value === 'bigint' ? Number(value) : (value == null ? null : Number(value)));
