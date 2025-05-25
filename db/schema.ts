import { pgTable, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
    id: text().primaryKey().default(sql),
    name: text(),
    username:text().notNull().unique()
});
