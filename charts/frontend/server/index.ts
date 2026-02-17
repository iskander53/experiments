import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../deviations.db");

const db = new Database(DB_PATH, { readonly: true });
db.pragma("journal_mode = WAL");

const app = express();
app.use(cors());

// Serve built frontend in production
const distPath = resolve(__dirname, "../dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
}

const VALID_DIMS = new Set([
  "stage", "deviation_category", "deviation", "warehouse",
  "customer", "employee", "shift", "hour", "day", "week", "month",
]);

// month is computed from day
function dimSelect(col: string): string {
  return col === "month" ? "strftime('%Y-%m', day) as month" : col;
}
function dimGroupBy(col: string): string {
  return col === "month" ? "strftime('%Y-%m', day)" : col;
}

const VALID_MEASURES = new Set(["deviation_count", "quantity", "amount_rub"]);

app.get("/", (_req, res) => {
  if (existsSync(distPath)) {
    return res.sendFile(join(distPath, "index.html"));
  }
  res.json({ ok: true, message: "Charts API. Run frontend: npm run dev. Endpoints: /api/dimensions, /api/data, /api/pivot" });
});

app.get("/api/dimensions", (_req, res) => {
  const dims: Record<string, (string | number)[]> = {};
  const cols = ["stage", "deviation_category", "deviation", "warehouse", "customer", "employee", "shift", "hour", "day", "week", "month"];
  for (const col of cols) {
    const sel = dimSelect(col);
    const rows = db.prepare(`SELECT DISTINCT ${sel} FROM deviations ORDER BY ${col === "month" ? "1" : col}`).all() as Record<string, string | number>[];
    dims[col] = rows.map((r) => r[col] ?? r["month"] ?? "");
  }
  res.json(dims);
});

app.get("/api/data", (req, res) => {
  const groupBy = (req.query.group_by as string) || "stage";
  const measure = (req.query.measure as string) || "deviation_count";

  const groupCols = groupBy.split(",").map((c) => c.trim()).filter((c) => VALID_DIMS.has(c));
  if (groupCols.length === 0) groupCols.push("stage");
  const safeMeasure = VALID_MEASURES.has(measure) ? measure : "deviation_count";

  // Optional filter by deviation_category
  const filterCategory = req.query.deviation_category as string | undefined;
  const validCategories = new Set(["По времени", "По количеству", "По качеству", "Неизвестно"]);
  const filterCats = filterCategory
    ? filterCategory.split(",").map((c) => c.trim()).filter((c) => validCategories.has(c))
    : [];

  const groupSelect = groupCols.map((c) => dimSelect(c)).join(", ");
  const groupByStr = groupCols.map((c) => dimGroupBy(c)).join(", ");
  let query = `SELECT ${groupSelect}, SUM(${safeMeasure}) as value FROM deviations`;
  const params: string[] = [];
  if (filterCats.length > 0) {
    const placeholders = filterCats.map(() => "?").join(", ");
    query += ` WHERE deviation_category IN (${placeholders})`;
    params.push(...filterCats);
  }
  query += ` GROUP BY ${groupByStr} HAVING value > 0 ORDER BY value DESC`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  const result = rows.map((r) => ({
    ...Object.fromEntries(groupCols.map((col) => [col, r[col]])),
    name: groupCols.map((col) => String(r[col])).join(" / "),
    value: r.value as number,
  }));

  res.json(result);
});

app.get("/api/pivot", (req, res) => {
  const rowParam = (req.query.row as string) || "stage";
  const colDim = (req.query.col as string) || "warehouse";
  const measuresParam = (req.query.measures as string) || "deviation_count";

  const rowDims = rowParam.split(",").map((c) => c.trim()).filter((c) => VALID_DIMS.has(c));
  if (rowDims.length === 0) rowDims.push("stage");
  const safeCol = VALID_DIMS.has(colDim) ? colDim : "warehouse";
  const measures = measuresParam.split(",").map((m) => m.trim()).filter((m) => VALID_MEASURES.has(m));
  if (measures.length === 0) measures.push("deviation_count");

  // Optional filter by deviation_category
  const filterCategory = req.query.deviation_category as string | undefined;
  const validCategories = new Set(["По времени", "По количеству", "По качеству", "Неизвестно"]);
  const filterCats = filterCategory
    ? filterCategory.split(",").map((c) => c.trim()).filter((c) => validCategories.has(c))
    : [];

  const selectMeasures = measures.map((m) => `SUM(${m}) as ${m}`).join(", ");
  const rowSelect = rowDims.map((c) => dimSelect(c)).join(", ");
  const rowGroupBy = rowDims.map((c) => dimGroupBy(c)).join(", ");
  const colSelect = dimSelect(safeCol);
  const colGroupBy = dimGroupBy(safeCol);
  let query = `SELECT ${rowSelect}, ${colSelect}, ${selectMeasures} FROM deviations`;
  const params: string[] = [];
  if (filterCats.length > 0) {
    const placeholders = filterCats.map(() => "?").join(", ");
    query += ` WHERE deviation_category IN (${placeholders})`;
    params.push(...filterCats);
  }
  query += ` GROUP BY ${rowGroupBy}, ${colGroupBy}`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  res.json(rows);
});

// ---- Times API (from times.tsv) ----
const TIMES_DIMS = new Set(["warehouse", "parent_type", "item_type", "employee", "op_type", "stage"]);
const TIMES_MEASURES = new Set(["time_spent", "time420", "ops", "productivity_loss_h", "idle_loss_h"]);

// Russian stage names mapping
const STAGE_NAME_MAP: Record<string, string> = {
  // parent_type mappings
  "UNLOADINGv2": "Разгрузка",
  "RECEIPTING": "Приемка",
  "CARGO_RECEIPTING": "Приемка ГМ",
  "MOVING_PLACING": "Перемещение",
  "PLACING": "Размещение",
  "STOCK_PLACING": "Размещение (сток)",
  "STOCK": "СТОК",
  "INVENTORY": "Инвентаризация",
  "COUNTING": "Подсчет",
  "PICKING": "Подбор",
  "STOCK_PICKING": "Подбор (сток)",
  "PACKING": "Упаковка",
  "CARGO": "Отгрузка ГМ",
  // op_type mappings
  "CARGO_PLACE": "ГМ Размещение",
  "CARGO_PICK": "ГМ Подбор",
  "CARGO_PACK": "Приемка ГМ",
  "CARGO_SHIP": "ГМ Отгрузка",
  "CARGO_RECEIPT": "Приемка ГМ",
  "MOVING | PLACING": "Перемещение",
  "UNLOAD": "Разгрузка",
  "UNLOADv2": "Разгрузка",
  "RECEIPTING_STICKERED": "Приемка (маркир.)",
  "RECEIPTING_NONSTICKERED": "Приемка (немаркир.)",
  "STOCK_RECEIPTING": "Приемка (сток)",
  "PLACE": "Размещение",
  "STOCK_PLACE": "Размещение (сток)",
  "PICK": "Подбор",
  "STOCK_PICK": "Подбор (сток)",
  "PICK_CONTAINER": "Подбор контейнера",
  "PICK_NEW_CELL": "Подбор новой ячейки",
  "PACK": "Упаковка",
  "PACK_NEW_BOX": "Упаковка (новая коробка)",
  "FAST_PACK": "Быстрая упаковка",
  "FAST_PACK_NEW_BOX": "Быстрая упаковка (нов.)",
  "REPACK": "Переупаковка",
  "REPICK": "Переподбор",
  "PRESORT": "Пресортировка",
  "SORT_CURVE": "Сортировка",
  "SORT_OIL": "Сортировка (масло)",
  "SORT_TO_MIXED_SITO": "Сорт. в смеш. сито",
  "SORT_TO_TROLLEY": "Сорт. в тележку",
  "CYCLE_COUNT": "Циклический подсчет",
  "MEASURE": "Измерение",
  "MOVE_TO_BOX_MEASURING": "Перемещение на измер.",
  "MOVE_TO_MZ": "Перемещение в MZ",
  "MOVE_TO_PACKING": "Перемещение на упак.",
  "CHECK_BIG_ON_RECEIPT": "Проверка крупного",
  "EXPERT_CHECK": "Экспертная проверка",
  "RECEIVING_CHECKS": "Проверки приемки",
  "0": "Прочее",
};

app.get("/api/times/data", (req, res) => {
  const groupBy = (req.query.group_by as string) || "parent_type";
  const measure = (req.query.measure as string) || "productivity_loss_h";

  // Handle special "stage" dimension: use op_type for CARGO, else parent_type
  const requestedCols = groupBy.split(",").map((c) => c.trim());
  const hasStage = requestedCols.includes("stage");
  const groupCols = requestedCols
    .filter((c) => c !== "stage")
    .filter((c) => TIMES_DIMS.has(c));
  
  if (hasStage) {
    // We'll compute effective_stage in the query
  }
  if (groupCols.length === 0 && !hasStage) groupCols.push("parent_type");
  
  const safeMeasure = TIMES_MEASURES.has(measure) ? measure : "productivity_loss_h";

  // Build query with effective_stage if needed
  const stageExpr = "CASE WHEN parent_type = 'CARGO' THEN op_type ELSE parent_type END";
  const selectCols = hasStage 
    ? [...groupCols, `${stageExpr} as stage`].join(", ")
    : groupCols.join(", ");
  const groupByCols = hasStage
    ? [...groupCols, stageExpr].join(", ")
    : groupCols.join(", ");

  const query = `
    SELECT ${selectCols}, 
           SUM(${safeMeasure}) as value,
           SUM(norm_h) as total_norm,
           SUM(time_spent) as total_time_spent,
           SUM(time420) as total_time420,
           SUM(pct_in_norm * ops) as weighted_pct_norm,
           SUM(ops) as total_ops
    FROM times 
    GROUP BY ${groupByCols} 
    HAVING value > 0 
    ORDER BY value DESC
  `;

  const rows = db.prepare(query).all() as Record<string, unknown>[];
  const allCols = hasStage ? [...groupCols, "stage"] : groupCols;
  
  const result = rows.map((r) => {
    const totalNorm = (r.total_norm as number) || 0;
    const totalTimeSpent = (r.total_time_spent as number) || 0;
    const totalTime420 = (r.total_time420 as number) || 0;
    const weightedPctNorm = (r.weighted_pct_norm as number) || 0;
    const totalOps = (r.total_ops as number) || 0;
    
    // productivity = sum(norm) / sum(time_spent) * 100
    const productivity = totalTimeSpent > 0 
      ? Math.min(100, (totalNorm / totalTimeSpent) * 100) 
      : 0;
    
    // utilization = sum(time_spent) / sum(time420) * 100
    const utilization = totalTime420 > 0 
      ? Math.min(100, (totalTimeSpent / totalTime420) * 100) 
      : 0;
    
    // опоздания (delays) = 100 - weighted average of pct_in_norm by ops
    const delays = totalOps > 0 ? 100 - (weightedPctNorm / totalOps) : 0;
    
    // Color metric: productivity * utilization / 10000 (normalized to 0-1)
    const prodUtil = Math.min(1, (productivity * utilization) / 10000);
    
    // Map stage to Russian name
    const stageVal = r.stage as string | undefined;
    const stageName = stageVal ? (STAGE_NAME_MAP[stageVal] || stageVal) : undefined;
    
    return {
      ...Object.fromEntries(allCols.map((col) => [col, col === "stage" ? stageName : r[col]])),
      name: allCols.map((col) => {
        const val = col === "stage" ? stageName : String(r[col]);
        return val;
      }).join(" / "),
      value: r.value as number,
      // Raw totals for proper aggregation in frontend
      totalNorm,
      totalTimeSpent,
      totalTime420,
      weightedPctNorm,
      totalOps,
      // Pre-calculated percentages (for leaf nodes)
      productivity,
      utilization,
      delays,
      prodUtil,
    };
  });

  res.json(result);
});

// Cycle time API: time_spent / ops by stage
const STAGE_ORDER: Record<string, number> = {
  "UNLOADINGv2": 1,
  "RECEIPTING": 2,
  "CARGO_RECEIPTING": 3,
  "MOVING_PLACING": 4,
  "PLACING": 5,
  "STOCK_PLACING": 6,
  "STOCK": 7,
  "INVENTORY": 8,
  "COUNTING": 9,
  "PICKING": 10,
  "STOCK_PICKING": 11,
  "PACKING": 12,
  "CARGO": 13,
  // CARGO op_types order
  "CARGO_PLACE": 14,
  "CARGO_PICK": 15,
  "CARGO_PACK": 16,
  "CARGO_SHIP": 17,
  "CARGO_RECEIPT": 18,
};

app.get("/api/times/cycletime", (req, res) => {
  const filterWarehouse = req.query.warehouse as string | undefined;
  const filterItemType = req.query.item_type as string | undefined;

  let query = `
    SELECT parent_type,
           SUM(time_spent) as total_time,
           SUM(ops) as total_ops
    FROM times
    WHERE 1=1
  `;
  const params: string[] = [];
  
  if (filterWarehouse) {
    query += ` AND warehouse = ?`;
    params.push(filterWarehouse);
  }
  if (filterItemType) {
    query += ` AND item_type = ?`;
    params.push(filterItemType);
  }
  
  query += ` GROUP BY parent_type HAVING total_ops > 0`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  
  const result = rows
    .map((r) => {
      const totalTime = (r.total_time as number) || 0;
      const totalOps = (r.total_ops as number) || 1;
      const cycleTime = totalTime / totalOps;
      const stage = r.parent_type as string;
      
      return {
        stage,
        cycleTime,
        totalTime,
        totalOps,
        order: STAGE_ORDER[stage] ?? 99,
      };
    })
    .sort((a, b) => a.order - b.order);

  res.json(result);
});

// Stacked bar API: weighted average suggested_norm by parent_type and op_type
app.get("/api/times/stacked", (req, res) => {
  const filterWarehouse = req.query.warehouse as string | undefined;

  let query = `
    SELECT parent_type, op_type,
           SUM(suggested_norm * time_spent) as weighted_norm,
           SUM(time_spent) as total_time,
           SUM(pct_in_norm * ops) as weighted_pct_norm,
           SUM(ops) as total_ops
    FROM times
    WHERE 1=1
  `;
  const params: string[] = [];
  
  if (filterWarehouse) {
    query += ` AND warehouse = ?`;
    params.push(filterWarehouse);
  }
  
  query += ` GROUP BY parent_type, op_type HAVING total_time > 0`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  
  const result = rows.map((r) => {
    const rawParentType = r.parent_type as string;
    const opType = r.op_type as string;
    const weightedNorm = (r.weighted_norm as number) || 0;
    const totalTime = (r.total_time as number) || 1;
    const weightedPctNorm = (r.weighted_pct_norm as number) || 0;
    const totalOps = (r.total_ops as number) || 1;
    
    // For CARGO, use op_type as the stage instead of parent_type
    const parentType = rawParentType === "CARGO" ? opType : rawParentType;
    const parentTypeLabel = STAGE_NAME_MAP[parentType] || parentType;
    
    // Weighted average: sum(suggested_norm * time_spent) / sum(time_spent) - already in seconds
    const value = weightedNorm / totalTime;
    // Delays = 100 - weighted average of pct_in_norm by ops
    const delays = 100 - (weightedPctNorm / totalOps);
    
    return {
      parentType,
      parentTypeLabel,
      opType,
      opTypeLabel: STAGE_NAME_MAP[opType] || opType,
      value,
      delays,
      order: rawParentType === "CARGO" ? (STAGE_ORDER[opType] ?? 14) : (STAGE_ORDER[rawParentType] ?? 99),
    };
  });

  res.json(result);
});

// SPA fallback: serve index.html for non-API routes in production
if (existsSync(distPath)) {
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(join(distPath, "index.html"));
  });
}

const PORT = parseInt(process.env.PORT || "5054", 10);
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
