import { MiddlewareHandler } from "hono";
import { checkValidUser } from ".";
import { getSessionId } from "./helpers";

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const sessionId = getSessionId(c);

  if (!sessionId) {
    return c.json({ message: "Missing token", success: false }, 401);
  }

  const user = await checkValidUser(sessionId);

  if (!user) {
    return c.json({ message: "Invalid or expired token", success: false }, 401);
  }
  c.set("user", user);
  await next();
};
