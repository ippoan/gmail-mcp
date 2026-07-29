import { Hono } from "hono";
import { createWorkerMcpV2 } from "@ippoan/mcp-cf-workers";
import { bindingJwtMiddleware } from "@ippoan/mcp-cf-workers/auth/binding-jwt-hono";
import type { BindingJwtClaims } from "@ippoan/mcp-cf-workers/auth/binding-jwt";
import { registerTools } from "./tools.js";
import { oauthRoutes } from "./oauth.js";
import { SERVER_NAME } from "./meta.js";
import type { Env } from "./types.js";

// MCP 2026-07-28 (SDK v2) factory。legacy (2025年代 initialize) クライアントも
// 同一エンドポイントで serve されるため、既存 connector は無変更で動く (Issue #15)。
const mcp = createWorkerMcpV2<Env>({
  name: SERVER_NAME,
  version: "0.1.0",
  registerTools,
});

const app = new Hono<{ Bindings: Env; Variables: { bindingJwt: BindingJwtClaims } }>();

// CF Access の前段でも通す軽い生存確認 (認証なし・情報なし)
app.get("/healthz", (c) => c.json({ ok: true }));

// アカウント追加/再認証フロー。エッジの CF Access host app (policy: me) が
// 人間認証を担う (Google からの redirect も同一ブラウザの Access session で通る)
app.route("/oauth", oauthRoutes);

// /mcp は CF Access 側で bypassAll (MCP client は browser flow を踏めない)。
// 認証は auth-worker mint の binding_jwt を /mcp/introspect に転送して検証する
// (secrets-inventory#43 と同じパターン。worker 側に shared secret は不要)。
// Hono の `/mcp/*` は `/mcp` 自身にマッチしないため両方に mount する。
const auth = () => bindingJwtMiddleware<Env>({ resourceMetadataSlug: "gmail-mcp" });
app.use("/mcp", auth());
app.use("/mcp/*", auth());
app.all("/mcp", (c) => mcp(c.req.raw, c.env));

export default app;
