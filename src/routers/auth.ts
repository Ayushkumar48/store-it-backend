import { Hono } from "hono";

const auth = new Hono();

auth.get("/login", (c) => {
    return c.text("Login Page");
});

auth.post("/signup", async (c) => {
    const body = await c.req.json();
    return c.json({ message: "Signup Success", body });
});

export default auth;
