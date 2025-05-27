import { eq } from "drizzle-orm";
import { db } from "../../db";
import { sessions, users } from "../../db/schema";
import { createSession } from "./session";
const DAY_IN_MS = 1000 * 60 * 60 * 24;

export async function checkValidUser(authToken: string) {
  if (!authToken) return null;
  try {
    const [result] = await db
      .select({
        session: sessions,
        user: users,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, authToken));

    if (!result) {
      return null;
    }

    const now = new Date();
    const expiresAt = new Date(result.session.expiresAt as Date);

    if (expiresAt < now) {
      return null;
    }

    const newExpiresAt = new Date(now.getTime() + DAY_IN_MS * 15);

    await db
      .update(sessions)
      .set({ expiresAt: newExpiresAt })
      .where(eq(sessions.id, authToken));

    return result.user;
  } catch (err) {
    console.error(err);
    return null;
  }
}

export async function doesUserExists(username: string | undefined | null) {
  if (!username || username === "") {
    return false;
  }
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));
  return !!existingUser;
}

export async function getExistingUser(username: string) {
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));
  return existingUser;
}

export async function signup(name: string, username: string, password: string) {
  const hash = await Bun.password.hash(password);
  const [savedUser] = await db
    .insert(users)
    .values({
      name,
      username,
      password: hash,
    })
    .returning();

  const sessionId = await createSession(savedUser.id);

  return { ...savedUser, password: null, sessionId };
}

export async function login(username: string, password: string) {
  const existingUser = await getExistingUser(username);
  const isValidUser = await Bun.password.verify(
    password,
    existingUser.password,
  );

  if (isValidUser) {
    const sessionId = await createSession(existingUser.id);
    return {
      success: true,
      sessionId,
      user: { ...existingUser, password: null },
    };
  }

  return { success: false, message: "Invalid login details!" };
}
