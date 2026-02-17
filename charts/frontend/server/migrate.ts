import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, "../../deviations.csv");
const TSV_PATH = resolve(__dirname, "../../times.tsv");
const DB_PATH = resolve(__dirname, "../../deviations.db");

function parseRussianDecimal(value: string): number {
  if (!value || value === "0") return 0;
  // Remove spaces (thousand separators) and replace comma with dot
  return parseFloat(value.replace(/\s/g, "").replace(",", "."));
}

function parseDate(value: string): string {
  if (!value) return "";
  const parts = value.trim().split(" ");
  const [day, month, year] = parts[0].split(".");
  const iso = `${year}-${month}-${day}`;
  return parts.length > 1 ? `${iso} ${parts[1]}:00` : iso;
}

console.log(`Reading CSV from ${CSV_PATH}...`);
const csv = readFileSync(CSV_PATH, "utf-8");
const records: string[][] = parse(csv, { delimiter: ",", relax_quotes: true });
const [header, ...rows] = records;
console.log(`CSV columns: ${header.join(", ")}`);
console.log(`Rows: ${rows.length}`);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`DROP TABLE IF EXISTS deviations`);
db.exec(`
  CREATE TABLE deviations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    datetime TEXT,
    day TEXT,
    week TEXT,
    hour INTEGER,
    shift INTEGER,
    stage TEXT,
    deviation_category TEXT,
    deviation TEXT,
    warehouse TEXT,
    customer TEXT,
    deviation_count INTEGER,
    quantity REAL,
    amount_rub REAL,
    employee TEXT
  )
`);

const insert = db.prepare(`
  INSERT INTO deviations
    (datetime, day, week, hour, shift, stage, deviation_category,
     deviation, warehouse, customer, deviation_count, quantity,
     amount_rub, employee)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMany = db.transaction((rows: string[][]) => {
  let skipped = 0;
  for (const row of rows) {
    if (row.length < 14) {
      skipped++;
      continue;
    }
    try {
      insert.run(
        parseDate(row[0]),
        parseDate(row[1]),
        parseDate(row[2]),
        parseInt(row[3]),
        parseInt(row[4]),
        row[5].trim(),
        row[6].trim(),
        row[7].trim(),
        row[8].trim(),
        row[9].trim(),
        parseInt(row[10]),
        parseRussianDecimal(row[11]),
        parseRussianDecimal(row[12]),
        row[13].trim()
      );
    } catch (e) {
      skipped++;
    }
  }
  return skipped;
});

const skipped = insertMany(rows);
const count = db.prepare("SELECT COUNT(*) as c FROM deviations").get() as { c: number };
console.log(`Migrated ${count.c} deviations rows (skipped ${skipped})`);

// ---- Migrate times.tsv ----
console.log(`\nReading TSV from ${TSV_PATH}...`);
const tsv = readFileSync(TSV_PATH, "utf-8");
const tsvRecords: string[][] = parse(tsv, { delimiter: "\t", relax_quotes: true, relax_column_count: true });
const [tsvHeader, ...tsvRows] = tsvRecords;
console.log(`TSV columns: ${tsvHeader.join(", ")}`);
console.log(`Rows: ${tsvRows.length}`);

db.exec(`DROP TABLE IF EXISTS times`);
db.exec(`
  CREATE TABLE times (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT,
    parent_type TEXT,
    item_type TEXT,
    employee TEXT,
    op_type TEXT,
    norm_h REAL,
    time_spent REAL,
    time420 REAL,
    suggested_norm REAL,
    pct_in_norm REAL,
    utilization REAL,
    ops INTEGER,
    productivity_loss_h REAL,
    idle_loss_h REAL
  )
`);

const insertTime = db.prepare(`
  INSERT INTO times
    (warehouse, parent_type, item_type, employee, op_type, norm_h, time_spent, time420,
     suggested_norm, pct_in_norm, utilization, ops, productivity_loss_h, idle_loss_h)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertManyTimes = db.transaction((rows: string[][]) => {
  let skipped = 0;
  for (const row of rows) {
    if (row.length < 14) {
      skipped++;
      continue;
    }
    try {
      insertTime.run(
        row[0].trim(),                              // warehouse
        row[1].trim(),                              // parent_type
        row[2].trim(),                              // item_type
        row[3].trim(),                              // employee
        row[4].trim(),                              // op_type (Type)
        parseRussianDecimal(row[5]),                // norm_h
        parseRussianDecimal(row[6]),                // time_spent (time30)
        parseRussianDecimal(row[7]),                // time420
        parseRussianDecimal(row[8]),                // suggested_norm
        parseRussianDecimal(row[9]),                // pct_in_norm
        parseRussianDecimal(row[10]),               // utilization
        parseInt(row[11].replace(/\s/g, "")) || 0,  // ops
        parseRussianDecimal(row[12]),               // productivity_loss_h
        parseRussianDecimal(row[13])                // idle_loss_h
      );
    } catch (e) {
      skipped++;
    }
  }
  return skipped;
});

const skippedTimes = insertManyTimes(tsvRows);
const countTimes = db.prepare("SELECT COUNT(*) as c FROM times").get() as { c: number };
console.log(`Migrated ${countTimes.c} times rows (skipped ${skippedTimes})`);

db.close();
console.log(`\nDone. Database: ${DB_PATH}`);
