// Transactions: every repo method takes an optional `tx`, so a state change, its outbox row and its
// pg-boss job (`jobDb(tx)`) commit or roll back together (ADR 0004, M1-03).
import type { Db } from "./client.ts";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anything a query can run on: the pool-backed client or an open transaction. */
export type Executor = Db | Tx;

/** Runs `fn` in one transaction; a thrown error rolls everything back. */
export function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
