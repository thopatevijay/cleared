// Top-level probe used by `describe.skipIf(!dbAvailable)` in the db-backed auth tests.
import { probeDatabase, TEST_DATABASE_URL } from "./db.ts";

export const dbAvailable = await probeDatabase(TEST_DATABASE_URL);
