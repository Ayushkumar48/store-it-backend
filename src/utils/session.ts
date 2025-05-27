import { eq } from "drizzle-orm";
import { db } from "../../db";
import { sessions, users } from "../../db/schema";

export async function createSession(userId: string) {
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

  const [userSession] = await db
    .insert(sessions)
    .values({ userId, expiresAt })
    .returning();
  return userSession.id;
}

export async function validateSession(sessionId: string) {
  const [result] = await db
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId));

  if (!result || new Date(result.session.expiresAt as Date) < new Date())
    return null;
  return result.user;
}

export async function invalidateSession(sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
