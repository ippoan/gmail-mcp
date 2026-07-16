import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    server: {
      deps: {
        // @ippoan/mcp-cf-workers は TS ソース直配布 (build 無し) のため、
        // externalize すると Node が .ts を読めず落ちる。vite に変換させる。
        inline: ["@ippoan/mcp-cf-workers"],
      },
    },
  },
});
