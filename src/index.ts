// Issue #1 で createWorkerMcp (@ippoan/mcp-cf-workers) の実装に置き換わる placeholder。
export default {
  async fetch(): Promise<Response> {
    return new Response("gmail-mcp: not implemented yet", { status: 501 });
  },
};
