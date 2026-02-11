import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, "../../deviations.csv");
const DB_PATH = resolve(__dirname, "../../deviations.db");

function parseRussianDecimal(value: string): number {
  if (!value || value === "0") return 0;
  return parseFloat(value.replace(",", "."));
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
console.log(`Migrated ${count.c} rows into ${DB_PATH} (skipped ${skipped})`);
db.close();
