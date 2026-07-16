// PR1 (Issue #1) で createWorkerMcp スケルトンに置き換わる placeholder。
// SEND_TOOLS_FORBIDDEN は tools/list snapshot テストの安全網としてこの時点から置く。
export const SERVER_NAME = "gmail-mcp";

export const FORBIDDEN_TOOL_PATTERNS: readonly RegExp[] = [
  /send/i, // messages.send / drafts.send 系はツールとして存在してはならない
];

export function assertNoForbiddenTools(toolNames: readonly string[]): void {
  const hit = toolNames.filter((name) =>
    FORBIDDEN_TOOL_PATTERNS.some((re) => re.test(name)),
  );
  if (hit.length > 0) {
    throw new Error(`forbidden tool names registered: ${hit.join(", ")}`);
  }
}
