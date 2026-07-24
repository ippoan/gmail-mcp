import type { Env } from "../src/types.js";

/** KVNamespace の最小 in-memory stub (get/put/delete/list + TTL は無視)。 */
export function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string, type?: string) {
      const value = store.get(key) ?? null;
      if (value === null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const keys = [...store.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
  return kv as unknown as KVNamespace;
}

/** AUTH_WORKER service binding の最小 stub (未使用時は呼ばれない)。 */
function fakeAuthWorkerBinding(): Fetcher {
  return {
    fetch: async () => new Response(null, { status: 501 }),
  } as unknown as Fetcher;
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    PUBLIC_ORIGIN: "https://gmail-mcp.example.test",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ACCOUNTS: fakeKv(),
    AUTH_WORKER: fakeAuthWorkerBinding(),
    ...overrides,
  };
}
