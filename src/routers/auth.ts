import { Hono } from "hono";
import { doesUserExists, login, signup } from "../utils";

const auth = new Hono();

auth.post("/login", async (c) => {
  try {
    const body = await c.req.json();
    const { username, password } = body;
    const existingUser = await doesUserExists(username);
    if (!existingUser) {
      return c.json({ success: false, message: "User doesn't exists!" }, 409);
    }
    const userLogin = await login(username, password);
    if (!userLogin.success) {
      return c.json({ success: false, message: userLogin.message }, 400);
    }
    return c.json(
      {
        message: "Logged in successfully!",
        user: userLogin.user,
        sessionId: userLogin.sessionId,
        success: true,
      },
      201,
    );
  } catch (err) {
    console.error("Login error:", err);
    return c.json({ message: "Internal server error", success: false }, 500);
  }
});

auth.post("/signup", async (c) => {
  try {
    const body = await c.req.json();
    const { name, username, password } = body;
    const existingUser = await doesUserExists(username);
    if (existingUser) {
      return c.json({ message: "User already exists!", success: false }, 409);
    }
    const savedUser = await signup(name, username, password);
    return c.json(
      {
        message: "Account created successfully!",
        user: savedUser,
        sessionId: savedUser.sessionId,
        success: true,
      },
      201,
    );
  } catch (err) {
    console.error("Signup error:", err);
    return c.json({ message: "Internal server error", success: false }, 500);
  }
});

export default auth;
