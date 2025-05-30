import { Hono } from "hono";
import auth from "./routers/auth";
import protectedRoutes from "./routers/protected-routes";
import { checkValidUser } from "./utils";

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.get("Content-Type")) {
    c.header("Content-Type", "application/json");
  }
});

app.post("/validate", async (c) => {
  try {
    const authToken = await c.req.json();
    const user = await checkValidUser(authToken);
    if (!user) {
      return c.json({ message: "Session expired", success: false }, 400);
    }
    return c.json({ message: "Valid Session", success: true, user }, 201);
  } catch (err) {
    console.error(err);
    return c.json({ message: "Error validating session", success: false }, 500);
  }
});

app.route("/auth", auth);
app.route("/", protectedRoutes);

app.get("/", async (c) => {
  return c.text("hello");
});

export default app;
