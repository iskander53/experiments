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
  "customer", "employee", "shift", "hour", "day", "week",
]);
const VALID_MEASURES = new Set(["deviation_count", "quantity", "amount_rub"]);

app.get("/api/dimensions", (_req, res) => {
  const dims: Record<string, (string | number)[]> = {};
  for (const col of ["stage", "deviation_category", "deviation", "warehouse", "customer", "employee", "shift"]) {
    const rows = db.prepare(`SELECT DISTINCT ${col} FROM deviations ORDER BY ${col}`).all() as Record<string, string | number>[];
    dims[col] = rows.map((r) => r[col]);
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

  const groupStr = groupCols.join(", ");
  let query = `SELECT ${groupStr}, SUM(${safeMeasure}) as value FROM deviations`;
  const params: string[] = [];
  if (filterCats.length > 0) {
    const placeholders = filterCats.map(() => "?").join(", ");
    query += ` WHERE deviation_category IN (${placeholders})`;
    params.push(...filterCats);
  }
  query += ` GROUP BY ${groupStr} HAVING value > 0 ORDER BY value DESC`;

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
  const rowStr = rowDims.join(", ");
  let query = `SELECT ${rowStr}, ${safeCol}, ${selectMeasures} FROM deviations`;
  const params: string[] = [];
  if (filterCats.length > 0) {
    const placeholders = filterCats.map(() => "?").join(", ");
    query += ` WHERE deviation_category IN (${placeholders})`;
    params.push(...filterCats);
  }
  query += ` GROUP BY ${rowStr}, ${safeCol}`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  res.json(rows);
});

// SPA fallback: serve index.html for non-API routes in production
if (existsSync(distPath)) {
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(join(distPath, "index.html"));
  });
}

const PORT = parseInt(process.env.PORT || "5001", 10);
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
