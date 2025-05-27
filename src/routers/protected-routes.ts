import { Hono } from "hono";
import { authMiddleware } from "../utils/authMiddleware";
import { type User } from "../../db/schema";

export type Variables = {
  user: Omit<User, "password">;
};

const protectedRoutes = new Hono<{ Variables: Variables }>();

protectedRoutes.use("*", authMiddleware);

protectedRoutes.get("/me", (c) => {
  const user = c.get("user");
  return c.json({ success: true, user });
});

export default protectedRoutes;
