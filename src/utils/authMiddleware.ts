import { MiddlewareHandler } from "hono";
import { checkValidUser } from ".";

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.split("Bearer ")[1];

  if (!token) {
    return c.json({ message: "Missing token", success: false }, 401);
  }

  const user = await checkValidUser(token);

  if (!user) {
    return c.json({ message: "Invalid or expired token", success: false }, 401);
  }
  c.set("user", user);
  await next();
};
