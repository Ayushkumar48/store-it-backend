import { Hono } from "hono";
import { authMiddleware } from "../utils/authMiddleware";
import { type User } from "../../db/schema";
import media from "./upload-media";

export type Variables = {
  user: Omit<User, "password">;
};

const protectedRoutes = new Hono<{ Variables: Variables }>();

protectedRoutes.use("*", authMiddleware);

protectedRoutes.route("/media", media);

export default protectedRoutes;
