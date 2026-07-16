# gmail-mcp

Gmail remote MCP — **read + draft only, no send** (TypeScript / Hono / Cloudflare Workers).

「読み取り＋下書きまで、送信は人間」を実装レベルで強制する Gmail remote MCP サーバー。

## 設計原則

- **send 系ツールは実装しない。** `messages.send` / `drafts.send` に到達する経路をサーバーに一切置かない。スコープ上は送信可能なトークン（`gmail.modify`）だが、MCP サーバーが送信エンドポイントを公開しないため Claude 経由の送信経路が存在しない
- 削除系は `delete_draft`（下書き）のみ。メッセージ/スレッドの TRASH 移動・完全削除は実装しない
- マルチアカウント前提: 全ツールに `account?: string`（エイリアス、省略時 `"default"`）
- MCP boilerplate は [`@ippoan/mcp-cf-workers`](https://github.com/ippoan/mcp-cf-workers)（`createWorkerMcp` + `cfAccessMiddleware`）
- エンドポイント: `gmail-mcp.ippoan.org`、CF Access（service token）で保護

実装計画は [Issue #1〜#5](https://github.com/ippoan/gmail-mcp/issues) を参照。

## 開発

```sh
npm install
npm run typecheck
npm test
```
