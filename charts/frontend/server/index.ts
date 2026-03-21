import express from "express";
import cors from "cors";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { config } from "dotenv";
import { ensureCache, aggregateRows, filterRows, pivotAggregate } from "./defects-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const app = express();
app.use(cors());
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on("finish", () => {
    const ms = Date.now() - start;
    if (req.path.startsWith("/api/")) console.log(`[${req.method}] ${req.path} ${ms}ms`);
  });
  next();
});

// Serve built frontend in production
const distPath = resolve(__dirname, "../dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
}

const VALID_DIMS = new Set([
  "stage", "deviation_category", "deviation", "deviation_source", "warehouse",
  "customer", "employee", "item_type", "shift", "hour", "day", "week", "month", "blame",
  "workstation",
]);

const VALID_MEASURES = new Set(["deviation_count", "quantity", "amount_rub"]);


app.get("/", (_req, res) => {
  if (existsSync(distPath)) {
    return res.sendFile(join(distPath, "index.html"));
  }
  res.json({ ok: true, message: "Charts API. Run frontend: npm run dev. Endpoints: /api/dimensions, /api/data, /api/pivot" });
});

const STATIC_DIMS: Record<string, (string | number)[]> = {
  stage: ["Неизвестно", "Отгрузка", "Отгрузка ГМ", "Подбор", "Получатель", "Приемка", "Размещение", "Размещение ГМ", "Размещение коробов", "Сортировка", "Упаковка", "Упаковка ГМ", "Хранение", "Экспертиза"],
  deviation_category: ["По времени", "По качеству", "По количеству", "Неизвестно"],
  deviation: ["Безусловный возврат", "Не было движений 30+ дней", "Неизвестно", "Опоздание", "брак", "излишек", "контрафакт", "недостача", "недостача 30д", "пересорт", "повреждение", "повреждение упаковки"],
  warehouse: ["BD1", "DWC", "K40", "K41", "KBD", "KDZ", "KTH"],
  item_type: ["BIG", "BOX", "NORMAL", "SMALL", "STOCK", "UNKNOWN"],
  shift: [1, 2],
  hour: Array.from({ length: 24 }, (_, i) => i),
  blame: ["Склад", "Поставщик", "Получатель"],
};

app.get("/api/dimensions", (_req, res) => {
  res.json(STATIC_DIMS);
});

app.get("/api/data", async (req, res) => {
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

  // Date range filter
  const dateFrom = req.query.date_from as string | undefined;
  const dateTo = req.query.date_to as string | undefined;
  
  // Deviation subtype filter
  const filterDeviation = req.query.deviation as string | undefined;
  const filterDevs = filterDeviation
    ? filterDeviation.split(",").map((d) => d.trim()).filter((d) => d)
    : [];

  try {
    const rows = await ensureCache(dateFrom || "2025-01-01", dateTo);
    const filters: Record<string, string | undefined> = { date_from: dateFrom, date_to: dateTo };
    if (filterCats.length > 0) filters.deviation_category = filterCats.join(",");
    if (filterDevs.length > 0) filters.deviation = filterDevs.join(",");
    for (const dim of VALID_DIMS) {
      if (dim === "deviation_category" || dim === "deviation") continue;
      const fv = req.query[dim] as string | undefined;
      if (fv) filters[dim] = fv;
    }
    const result = aggregateRows(rows, groupCols, safeMeasure as "deviation_count" | "quantity" | "amount_rub", filters);
    res.json(result);
  } catch (e) {
    console.error("[/api/data] error:", e);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// Get raw rows filtered by dimension values (for detail view)
app.get("/api/data/rows", async (req, res) => {
  const filters = req.query as Record<string, string>;
  
  try {
    const allRows = await ensureCache(filters.date_from || "2025-01-01", filters.date_to);
    const result = filterRows(allRows, filters, 500);
    res.json(result);
  } catch (e) {
    console.error("[/api/data/rows] error:", e);
    res.status(500).json({ error: "Failed to fetch rows" });
  }
});

app.get("/api/pivot", async (req, res) => {
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

  // Warehouse filter
  const filterWarehouse = req.query.warehouse as string | undefined;
  
  // Date range filter
  const dateFrom = req.query.date_from as string | undefined;
  const dateTo = req.query.date_to as string | undefined;

  try {
    const allRows = await ensureCache(dateFrom || "2025-01-01", dateTo);
    const filters: Record<string, string | undefined> = { date_from: dateFrom, date_to: dateTo };
    if (filterCats.length > 0) filters.deviation_category = filterCats.join(",");
    if (filterWarehouse) filters.warehouse = filterWarehouse;
    const filterBlame = req.query.blame as string | undefined;
    if (filterBlame) filters.blame = filterBlame;
    const result = pivotAggregate(allRows, rowDims, safeCol, measures, filters);
    res.json(result);
  } catch (e) {
    console.error("[/api/pivot] error:", e);
    res.status(500).json({ error: "Failed to fetch pivot data" });
  }
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

  const today = new Date();
  const threeMonthsAgo = new Date(today);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const from = threeMonthsAgo.toISOString().split("T")[0];
  const to = today.toISOString().split("T")[0];
  ensureCache(from, to).catch((e) => console.error("[Cache] Warm-up failed:", e));
});
