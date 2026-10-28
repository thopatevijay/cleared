// Drizzle schema, migrations and workspace-scoped repositories. Filled in by M0-03 and M1-02.
import { CORE_PACKAGE } from "@cleared/core";

export const DB_PACKAGE = "@cleared/db";
export const dependsOn: readonly string[] = [CORE_PACKAGE];
