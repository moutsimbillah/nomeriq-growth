import { AsyncLocalStorage } from "node:async_hooks";
import type { DbClient } from "./client";

const dbContext = new AsyncLocalStorage<DbClient>();

/** Run a short synchronous database workflow against the supplied transaction client. */
export function withDbContext<T>(db: DbClient, fn: () => Promise<T>): Promise<T> {
  return dbContext.run(db, fn);
}

/** The transaction client for the current workflow, if one was installed. */
export function currentDbContext(): DbClient | undefined {
  return dbContext.getStore();
}
