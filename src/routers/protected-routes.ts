import { Hono } from "hono";
import { authMiddleware } from "../utils/authMiddleware";
import { type User } from "../../db/schema";
import media from "./upload-media";
import { updateProfile } from "../utils";

export type Variables = {
  user: Omit<User, "password">;
};

const protectedRoutes = new Hono<{ Variables: Variables }>();

protectedRoutes.use("*", authMiddleware);
protectedRoutes.post("/edit-profile", async (c) => {
  try {
    const { name, password, userId } = await c.req.json();
    const details = await updateProfile(name, password, userId);
    if (!details.success) {
      return c.json(details, 400);
    }
    return c.json(details, 200);
  } catch (err) {
    console.error(err);
    return c.json(
      {
        message: "Internal Server Error",
        success: false,
      },
      500,
    );
  }
});

protectedRoutes.route("/media", media);

export default protectedRoutes;
