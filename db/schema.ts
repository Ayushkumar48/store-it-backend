import { sql } from "drizzle-orm";
import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const mediaTypeEnum = pgEnum("media_type", ["video", "image"]);

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

export const medias = pgTable("medias", {
  id: text()
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  mediaType: mediaTypeEnum().notNull(),
  cloudUrl: text("cloud_url").notNull(),
  cloudfrontUrl: text("cloudfront_url").notNull(),
  userId: text("user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// export const videosThumbnails = pgTable("video_thumbnails", {
//   id: text()
//     .primaryKey()
//     .default(sql`gen_random_uuid()`),
//   mediaId: text("media_id").references(() => medias.id),
//   cloudUrl: text("cloud_url").notNull(),
//   cloudfrontUrl: text("cloudfront_url").notNull(),
//   userId: text("user_id").references(() => users.id),
//   createdAt: timestamp("created_at").defaultNow().notNull(),
// });

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Media = typeof medias.$inferSelect;
export type NewMedia = typeof medias.$inferInsert;
