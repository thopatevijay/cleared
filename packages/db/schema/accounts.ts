// Accounts (ADR 0007): workspaces, sellers, sessions, magic links, notifications.
import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, currency, pk, tstz } from "./columns.ts";
import { locale, sessionKind, workspaceKind } from "./enums.ts";

export const workspaces = pgTable(
  "workspaces",
  {
    id: pk(),
    kind: workspaceKind("kind").notNull(),
    locale: locale("locale").notNull().default("en"),
    timezone: text("timezone").notNull(),
    baseCurrency: currency("base_currency").notNull(),
    createdAt: createdAt(),
    /** demo: DEMO_WORKSPACE_EXPIRES_AT; seller: null */
    expiresAt: tstz("expires_at"),
    /** HMAC of the creating IP, for the demo caps (M1-05); never the raw IP */
    createdIpHash: text("created_ip_hash"),
    /** per-workspace LLM budget in USD (demo: 0.10, ADR 0007); null = no per-workspace cap */
    llmBudgetUsd: numeric("llm_budget_usd"),
  },
  (t) => [
    index("workspaces_created_at_idx").on(t.createdAt),
    index("workspaces_created_ip_hash_idx").on(t.createdIpHash, t.createdAt),
  ],
);

const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id);

/** Columns every workspace-scoped table starts with. */
export const scoped = () => ({ id: pk(), workspaceId: workspaceId(), createdAt: createdAt() });

export const users = pgTable(
  "users",
  {
    ...scoped(),
    /** sellers only, stored lower-cased; demo workspaces have no user */
    email: text("email").notNull(),
    displayName: text("display_name"),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    check("users_email_lower", sql`${t.email} = lower(${t.email})`),
    index("users_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    ...scoped(),
    userId: uuid("user_id").references(() => users.id),
    kind: sessionKind("kind").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    lastSeenAt: tstz("last_seen_at"),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const magicLinks = pgTable(
  "magic_links",
  {
    ...scoped(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    usedAt: tstz("used_at"),
  },
  (t) => [
    uniqueIndex("magic_links_token_hash_key").on(t.tokenHash),
    index("magic_links_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    ...scoped(),
    kind: text("kind").notNull(),
    sentVia: text("sent_via"),
    sentAt: tstz("sent_at"),
    readAt: tstz("read_at"),
  },
  (t) => [index("notifications_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);
