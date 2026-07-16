import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { oauthRoutes } from "../src/oauth.js";
import { getAccount } from "../src/accounts.js";
import type { Env } from "../src/types.js";
import { testEnv } from "./helpers.js";

function app() {
  return new Hono<{ Bindings: Env }>().route("/oauth", oauthRoutes);
}

// Google token endpoint + Gmail profile を route する fetch stub
function stubGoogle() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({
          access_token: "at-1",
          refresh_token: "rt-1",
          scope: "https://www.googleapis.com/auth/gmail.modify",
          token_type: "Bearer",
          expires_in: 3599,
        });
      }
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/profile")) {
        return Response.json({ emailAddress: "me@example.com" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/oauth/start", () => {
  it("redirects to Google consent with offline access + state nonce in KV", async () => {
    const env = testEnv();
    const res = await app().request("/oauth/start?alias=work", {}, env);
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("Location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.modify",
    );
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");

    const state = location.searchParams.get("state")!;
    const stored = await env.ACCOUNTS.get(`state:${state}`, "json");
    expect(stored).toEqual({ alias: "work" });
  });

  it("rejects invalid alias", async () => {
    const res = await app().request("/oauth/start?alias=NG%20alias", {}, testEnv());
    expect(res.status).toBe(400);
  });
});

describe("/oauth/callback", () => {
  async function startAndGetState(env: Env): Promise<string> {
    const res = await app().request("/oauth/start?alias=work", {}, env);
    return new URL(res.headers.get("Location")!).searchParams.get("state")!;
  }

  it("exchanges code, stores account, and consumes state (CSRF one-shot)", async () => {
    stubGoogle();
    const env = testEnv();
    const state = await startAndGetState(env);

    const res = await app().request(`/oauth/callback?code=c-1&state=${state}`, {}, env);
    expect(res.status).toBe(200);

    const account = await getAccount(env, "work");
    expect(account?.email).toBe("me@example.com");
    expect(account?.refresh_token).toBe("rt-1");
    expect(account?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);

    // 同じ state の再利用は拒否 (one-shot)
    const replay = await app().request(`/oauth/callback?code=c-2&state=${state}`, {}, env);
    expect(replay.status).toBe(400);
  });

  it("rejects unknown state", async () => {
    stubGoogle();
    const res = await app().request("/oauth/callback?code=c-1&state=bogus", {}, testEnv());
    expect(res.status).toBe(400);
  });

  it("surfaces Google-side denial", async () => {
    const res = await app().request("/oauth/callback?error=access_denied", {}, testEnv());
    expect(res.status).toBe(400);
  });
});
