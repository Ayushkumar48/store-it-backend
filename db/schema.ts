import { sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text()
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text().notNull(),
  username: text().notNull().unique(),
  password: text().notNull(),
  createdAt: timestamp().defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: text("user_id").references(() => users.id),
  expiresAt: timestamp("expires_at"),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
