// drizzle-kit config: generates SQL migrations into ./migrations. Domain tables arrive in M1-02 (./schema).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema",
  out: "./migrations",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://cleared:cleared@localhost:5432/cleared",
  },
  migrations: { table: "__drizzle_migrations", schema: "drizzle" },
});
