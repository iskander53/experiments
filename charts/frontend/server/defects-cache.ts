import { querySnowflake } from "./snowflake.js";
import { buildDefectsCTE, mapRow } from "./defects-query.js";

export interface DefectRow {
  datetime: string;
  day: string;
  week: string;
  hour: number;
  shift: number;
  stage: string;
  deviation_category: string;
  deviation: string;
  warehouse: string;
  customer: string;
  deviation_count: number;
  quantity: number;
  amount_rub: number;
  employee: string;
  product_name: string;
  item_type: string;
  blame: string;
  workstation: string;
  deviation_source: string;
  month: string;
}

let cachedRows: DefectRow[] = [];
let cachedFrom: string | null = null;
let cachedTo: string | null = null;
let loadingPromise: Promise<void> | null = null;

function rowToDefect(raw: Record<string, unknown>): DefectRow {
  const m = mapRow(raw);
  const day = String(m.day ?? "");
  return {
    datetime: String(m.datetime ?? ""),
    day,
    week: String(m.week ?? ""),
    hour: Number(m.hour ?? 0),
    shift: Number(m.shift ?? 0),
    stage: String(m.stage ?? ""),
    deviation_category: String(m.deviation_category ?? ""),
    deviation: String(m.deviation ?? ""),
    warehouse: String(m.warehouse ?? ""),
    customer: String(m.customer ?? ""),
    deviation_count: Number(m.deviation_count ?? 0),
    quantity: Number(m.quantity ?? 0),
    amount_rub: Number(m.amount_rub ?? 0),
    employee: String(m.employee ?? ""),
    product_name: String(m.product_name ?? ""),
    item_type: String(m.item_type ?? ""),
    blame: String(m.blame ?? ""),
    workstation: String(m.workstation ?? ""),
    deviation_source: String(m.deviation_source ?? ""),
    month: day.slice(0, 7),
  };
}

async function fetchRange(dateFrom: string, dateTo?: string): Promise<DefectRow[]> {
  const t0 = Date.now();
  console.log(`[Cache] Fetching Snowflake range ${dateFrom} → ${dateTo ?? "now"}...`);
  const cte = buildDefectsCTE(dateFrom, dateTo);
  const sql = `${cte} SELECT * FROM all_defects_final`;
  const rows = await querySnowflake<Record<string, unknown>>(sql);
  const result = rows.map(rowToDefect);
  console.log(`[Cache] Fetched ${result.length} rows in ${Date.now() - t0}ms`);
  return result;
}

/**
 * Ensures cache covers [dateFrom, dateTo].
 *
 * The SQL uses dateFrom as an anchor for 30-day lookback windows, so fetching
 * a small delta with a different anchor re-runs the entire heavy query anyway.
 * Instead, when the range widens we re-fetch the full widened span once.
 */
export async function ensureCache(dateFrom: string, dateTo?: string): Promise<DefectRow[]> {
  const reqTo = dateTo || "2099-12-31";

  if (cachedFrom !== null && cachedTo !== null) {
    if (dateFrom >= cachedFrom && reqTo <= cachedTo) {
      return cachedRows;
    }
  }

  // If another load is in progress, wait for it then re-check
  if (loadingPromise) {
    await loadingPromise;
    if (cachedFrom !== null && cachedTo !== null && dateFrom >= cachedFrom && reqTo <= cachedTo) {
      return cachedRows;
    }
  }

  const doLoad = async () => {
    const wideFrom = cachedFrom && cachedFrom < dateFrom ? cachedFrom : dateFrom;
    const wideTo = cachedTo && cachedTo > reqTo ? cachedTo : reqTo;

    cachedRows = await fetchRange(wideFrom, wideTo === "2099-12-31" ? undefined : wideTo);
    cachedFrom = wideFrom;
    cachedTo = wideTo;
  };

  loadingPromise = doLoad();
  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
  return cachedRows;
}

export function getCachedRows(): DefectRow[] {
  return cachedRows;
}

export function isCacheReady(): boolean {
  return cachedRows.length > 0;
}

type AggResult = Record<string, unknown> & { value: number };

export function aggregateRows(
  rows: DefectRow[],
  groupCols: string[],
  measure: "deviation_count" | "quantity" | "amount_rub",
  filters: Record<string, string | string[] | undefined>,
): AggResult[] {
  const filtered = applyFilters(rows, filters);

  const groups = new Map<string, number>();
  const groupData = new Map<string, Record<string, unknown>>();

  for (const row of filtered) {
    const keyParts = groupCols.map((c) => String(dimVal(row, c)));
    const key = keyParts.join("|||");
    groups.set(key, (groups.get(key) ?? 0) + (row[measure as keyof DefectRow] as number));
    if (!groupData.has(key)) {
      const data: Record<string, unknown> = {};
      for (const c of groupCols) data[c] = dimVal(row, c);
      groupData.set(key, data);
    }
  }

  const result: AggResult[] = [];
  for (const [key, value] of groups) {
    if (value <= 0) continue;
    const data = groupData.get(key)!;
    result.push({
      ...data,
      name: groupCols.map((c) => String(data[c])).join(" / "),
      value,
    });
  }
  result.sort((a, b) => b.value - a.value);
  return result;
}

export function filterRows(
  rows: DefectRow[],
  filters: Record<string, string | string[] | undefined>,
  limit = 500,
): DefectRow[] {
  const filtered = applyFilters(rows, filters);
  filtered.sort((a, b) => (b.datetime > a.datetime ? 1 : -1));
  return filtered.slice(0, limit);
}

export function pivotAggregate(
  rows: DefectRow[],
  rowDims: string[],
  colDim: string,
  measures: string[],
  filters: Record<string, string | string[] | undefined>,
): Record<string, unknown>[] {
  const filtered = applyFilters(rows, filters);
  const allDims = [...rowDims, colDim];

  const groups = new Map<string, Record<string, number>>();
  const groupData = new Map<string, Record<string, unknown>>();

  for (const row of filtered) {
    const keyParts = allDims.map((c) => String(dimVal(row, c)));
    const key = keyParts.join("|||");
    if (!groups.has(key)) {
      groups.set(key, {});
      const data: Record<string, unknown> = {};
      for (const c of allDims) data[c] = dimVal(row, c);
      groupData.set(key, data);
    }
    const agg = groups.get(key)!;
    for (const m of measures) {
      agg[m] = (agg[m] ?? 0) + (row[m as keyof DefectRow] as number);
    }
  }

  const result: Record<string, unknown>[] = [];
  for (const [key, agg] of groups) {
    result.push({ ...groupData.get(key)!, ...agg });
  }
  return result;
}

function dimVal(row: DefectRow, dim: string): string | number {
  if (dim === "month") return row.month;
  return row[dim as keyof DefectRow] as string | number;
}

function applyFilters(
  rows: DefectRow[],
  filters: Record<string, string | string[] | undefined>,
): DefectRow[] {
  return rows.filter((row) => {
    for (const [key, val] of Object.entries(filters)) {
      if (!val || key === "date_from" || key === "date_to") continue;

      if (key === "deviation_category") {
        const cats = Array.isArray(val) ? val : val.split(",").map((s) => s.trim());
        if (cats.length > 0 && !cats.includes(row.deviation_category)) return false;
        continue;
      }
      if (key === "deviation") {
        const devs = Array.isArray(val) ? val : val.split(",").map((s) => s.trim());
        if (devs.length > 0 && !devs.includes(row.deviation)) return false;
        continue;
      }

      const rowVal = dimVal(row, key);
      if (rowVal === undefined) continue;
      if (String(rowVal) !== String(val)) return false;
    }

    if (filters.date_from && row.day < String(filters.date_from)) return false;
    if (filters.date_to && row.day > String(filters.date_to)) return false;

    return true;
  });
}
