import snowflake from "snowflake-sdk";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

snowflake.configure({ logLevel: "WARN" });

const connectionConfig: snowflake.ConnectionOptions = {
  account: process.env.SNOWFLAKE_ACCOUNT!,
  username: process.env.SNOWFLAKE_USERNAME!,
  password: process.env.SNOWFLAKE_PASSWORD!,
  database: process.env.SNOWFLAKE_DATABASE || "DWH",
  warehouse: process.env.SNOWFLAKE_WAREHOUSE,
  role: process.env.SNOWFLAKE_ROLE,
};

const POOL_SIZE = 3;
const pool: snowflake.Connection[] = [];
const available: snowflake.Connection[] = [];
let initializing = false;
const waiters: ((conn: snowflake.Connection) => void)[] = [];

function createConnection(): Promise<snowflake.Connection> {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(connectionConfig);
    conn.connect((err) => {
      if (err) return reject(err);
      resolve(conn);
    });
  });
}

async function initPool(): Promise<void> {
  if (initializing || pool.length > 0) return;
  initializing = true;
  console.log(`[Snowflake] Initializing pool with ${POOL_SIZE} connections...`);
  const promises = Array.from({ length: POOL_SIZE }, () => createConnection());
  const conns = await Promise.all(promises);
  pool.push(...conns);
  available.push(...conns);
  console.log(`[Snowflake] Pool ready (${POOL_SIZE} connections)`);
}

function acquire(): Promise<snowflake.Connection> {
  const conn = available.pop();
  if (conn) return Promise.resolve(conn);
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

function release(conn: snowflake.Connection): void {
  const waiter = waiters.shift();
  if (waiter) {
    waiter(conn);
  } else {
    available.push(conn);
  }
}

export async function querySnowflake<T = Record<string, unknown>>(
  sql: string,
  binds: (string | number)[] = []
): Promise<T[]> {
  await initPool();
  const conn = await acquire();
  try {
    return await new Promise<T[]>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds: binds as snowflake.Binds,
        complete: (err, _stmt, rows) => {
          if (err) return reject(err);
          resolve((rows || []) as T[]);
        },
      });
    });
  } finally {
    release(conn);
  }
}

// Keep connections warm with periodic pings
setInterval(async () => {
  if (pool.length === 0) return;
  for (const conn of pool) {
    try {
      await new Promise<void>((resolve, reject) => {
        conn.execute({
          sqlText: "SELECT 1",
          complete: (err) => (err ? reject(err) : resolve()),
        });
      });
    } catch (e) {
      console.warn("[Snowflake] Keepalive ping failed:", e);
    }
  }
}, 5 * 60 * 1000); // every 5 minutes
