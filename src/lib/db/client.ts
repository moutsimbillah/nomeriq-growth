import fs from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgliteClient implements DbClient {
  constructor(public readonly db: PGlite) {}

  async query<T>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.db.query<T>(text, params);
    return {
      rows: (result.rows ?? []) as T[],
      rowCount: result.affectedRows ?? result.rows?.length ?? 0,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const wrapped: DbClient = {
        query: async <R>(text: string, params: unknown[] = []) => {
          const result = await tx.query<R>(text, params);
          return {
            rows: (result.rows ?? []) as R[],
            rowCount: result.affectedRows ?? result.rows?.length ?? 0,
          };
        },
        exec: async (sql: string) => {
          await tx.exec(sql);
        },
        transaction: async <R>(nested: (inner: DbClient) => Promise<R>) => nested(wrapped),
        close: async () => {},
      };
      return fn(wrapped);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

class PgClient implements DbClient {
  constructor(private readonly pool: Pool) {}

  async query<T>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(text, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const wrapped = new PgTransactionClient(client);
      const result = await fn(wrapped);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgTransactionClient implements DbClient {
  constructor(private readonly client: PoolClient) {}

  async query<T>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.client.query(text, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

type DbGlobal = {
  client?: Promise<DbClient>;
  migrated?: Promise<void>;
};

const globalForDb = globalThis as typeof globalThis & {
  __nomeriqGrowthDb?: DbGlobal;
};

const dbGlobal: DbGlobal = (globalForDb.__nomeriqGrowthDb ??= {});

function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url || undefined;
}

async function createClient(): Promise<DbClient> {
  const url = databaseUrl();
  if (url) {
    const needsSsl =
      /supabase\.co|pooler\.supabase\.com/i.test(url) ||
      /sslmode=require/i.test(url);
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
    await pool.query("SELECT 1");
    return new PgClient(pool);
  }

  if (process.env.VERCEL) {
    throw new Error(
      "DATABASE_URL is not configured. Growth cannot use its local embedded database on Vercel. Add the Supabase PostgreSQL connection string and redeploy.",
    );
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PGLITE_PRODUCTION !== "true"
  ) {
    throw new Error(
      "DATABASE_URL is not configured. Growth cannot use its local embedded database in production. Add the Supabase PostgreSQL connection string, or set ALLOW_PGLITE_PRODUCTION=true only for a local production preview.",
    );
  }

  const dir = path.resolve(
    process.cwd(),
    process.env.PGLITE_DIR?.trim() || ".data/pglite",
  );
  await fs.mkdir(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return new PgliteClient(db);
}

async function applyMigrations(client: DbClient): Promise<void> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const migrationDir = path.join(process.cwd(), "src", "db", "migrations");
  let files: string[];
  try {
    files = (await fs.readdir(migrationDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
  } catch {
    throw new Error(
      "Database migration files are not available in this runtime. Run `npm run db:migrate` against DATABASE_URL before starting production.",
    );
  }

  const applied = await client.query<{ id: string }>("SELECT id FROM _migrations");
  const appliedIds = new Set(applied.rows.map((row) => row.id));

  for (const file of files) {
    if (appliedIds.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationDir, file), "utf8");
    await client.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO _migrations (id) VALUES ($1)", [file]);
    });
  }
}

export async function getDb(): Promise<DbClient> {
  if (!dbGlobal.client) {
    dbGlobal.client = createClient().catch((error) => {
      dbGlobal.client = undefined;
      throw error;
    });
  }
  const client = await dbGlobal.client;

  if (process.env.AUTO_MIGRATE !== "false" && !dbGlobal.migrated) {
    dbGlobal.migrated = applyMigrations(client).catch((error) => {
      dbGlobal.migrated = undefined;
      throw error;
    });
  }
  if (dbGlobal.migrated) await dbGlobal.migrated;
  return client;
}

export async function closeDb(): Promise<void> {
  if (dbGlobal.client) {
    const client = await dbGlobal.client.catch(() => undefined);
    await client?.close();
  }
  dbGlobal.client = undefined;
  dbGlobal.migrated = undefined;
}

export async function resetLocalDatabaseFiles(): Promise<void> {
  if (databaseUrl()) {
    throw new Error("Refusing to reset a remote PostgreSQL database.");
  }
  const dir = path.resolve(
    process.cwd(),
    process.env.PGLITE_DIR?.trim() || ".data/pglite",
  );
  await closeDb();
  await fs.rm(dir, { recursive: true, force: true });
}
