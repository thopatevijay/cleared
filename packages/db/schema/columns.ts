// Shared column builders. Every timestamp is `timestamptz` (UTC); money amounts are `numeric` without a
// scale, so the canonical string from `@cleared/core` ("42.00", "1000") round-trips unchanged.
import { char, customType, numeric, timestamp, uuid } from "drizzle-orm/pg-core";

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const createdAt = () => tstz("created_at").notNull().defaultNow();

export const pk = () => uuid("id").primaryKey().defaultRandom();

export const money = (name: string) => numeric(name);

export const currency = (name: string) => char(name, { length: 3 });

/** sha256 as 64 lowercase hex characters (`Sha256` in `@cleared/core`). */
export const sha256 = (name: string) => char(name, { length: 64 });

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
