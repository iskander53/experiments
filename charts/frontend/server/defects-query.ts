/**
 * Loads canonical SQL from repo-root `deviations.sql` and injects the report anchor date.
 * The file ends with CTE `all_defects_final`; callers append `SELECT * FROM all_defects_final`.
 */
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function sanitizeDate(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid date format: ${d}`);
  return d;
}

/** Anchor date used throughout deviations.sql (was hardcoded as 2026-01-01). */
const ANCHOR = "2026-01-01";

function resolveDeviationsSqlPath(): string {
  const candidates = [
    join(__dirname, "../../deviations.sql"),
    join(__dirname, "../../../deviations.sql"),
    join(process.cwd(), "deviations.sql"),
    join(process.cwd(), "../deviations.sql"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "deviations.sql not found. Expected at repo root or set cwd. Tried: " + candidates.join(", "),
  );
}

let cachedSqlTemplate: string | null = null;

function loadSqlTemplate(): string {
  if (cachedSqlTemplate) return cachedSqlTemplate;
  const path = resolveDeviationsSqlPath();
  cachedSqlTemplate = readFileSync(path, "utf8");
  return cachedSqlTemplate;
}

export function buildDefectsCTE(dateFrom: string, _dateTo?: string): string {
  const safeFrom = sanitizeDate(dateFrom);
  let sql = loadSqlTemplate();

  // Replace anchor date (longest patterns first)
  sql = sql.replaceAll(`'${ANCHOR}'::timestamp_ntz`, `'${safeFrom}'::timestamp_ntz`);
  sql = sql.replaceAll(`'${ANCHOR}'::timestamp`, `'${safeFrom}'::timestamp`);
  sql = sql.replaceAll(`'${ANCHOR}'`, `'${safeFrom}'`);

  if (!sql.includes("all_defects_final")) {
    throw new Error("deviations.sql must define CTE all_defects_final (BD ∪ KDZ ∪ DWC).");
  }

  return sql.trim();
}

export const SF_COL_MAP: Record<string, string> = {
  ДатаВремя: "datetime",
  День: "day",
  Неделя: "week",
  Час: "hour",
  Смена: "shift",
  Этап: "stage",
  "Категория отклонения": "deviation_category",
  Отклонение: "deviation",
  "Отклонение из источника": "deviation_source",
  Склад: "warehouse",
  Заказчик: "customer",
  "Количество отклонений": "deviation_count",
  "Кол-во шт в отклонении": "quantity",
  "Сумма в руб. отклонений": "amount_rub",
  USER: "employee",
  user: "employee",
  Наименование: "product_name",
  "Тип товара": "item_type",
  Виновник: "blame",
  "Рабочее место": "workstation",
};

export function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const newKey = SF_COL_MAP[key] || key;
    mapped[newKey] = value;
  }
  if (mapped.datetime instanceof Date) mapped.datetime = mapped.datetime.toISOString().replace("T", " ").split(".")[0];
  if (mapped.day instanceof Date) mapped.day = mapped.day.toISOString().split("T")[0];
  if (mapped.week instanceof Date) mapped.week = mapped.week.toISOString().split("T")[0];
  return mapped;
}
