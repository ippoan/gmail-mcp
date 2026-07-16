import { Hono } from "hono";
import { createWorkerMcp } from "@ippoan/mcp-cf-workers";
import { bindingJwtMiddleware } from "@ippoan/mcp-cf-workers/auth/binding-jwt-hono";
import type { BindingJwtClaims } from "@ippoan/mcp-cf-workers/auth/binding-jwt";
import { registerTools } from "./tools.js";
import { SERVER_NAME } from "./meta.js";
import type { Env } from "./types.js";

const mcp = createWorkerMcp<Env>({
  name: SERVER_NAME,
  version: "0.1.0",
  registerTools,
});

const app = new Hono<{ Bindings: Env; Variables: { bindingJwt: BindingJwtClaims } }>();

// CF Access の前段でも通す軽い生存確認 (認証なし・情報なし)
app.get("/healthz", (c) => c.json({ ok: true }));

// /mcp は CF Access 側で bypassAll (MCP client は browser flow を踏めない)。
// 認証は auth-worker mint の binding_jwt を /mcp/introspect に転送して検証する
// (secrets-inventory#43 と同じパターン。worker 側に shared secret は不要)。
// Hono の `/mcp/*` は `/mcp` 自身にマッチしないため両方に mount する。
const auth = () => bindingJwtMiddleware<Env>({ resourceMetadataSlug: "gmail-mcp" });
app.use("/mcp", auth());
app.use("/mcp/*", auth());
app.all("/mcp", (c) => mcp(c.req.raw, c.env));

export default app;
