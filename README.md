# gmail-mcp

Gmail remote MCP — **read + draft only, no send** (TypeScript / Hono / Cloudflare Workers).

「読み取り＋下書きまで、送信は人間」を実装レベルで強制する Gmail remote MCP サーバー。

- エンドポイント: `https://gmail-mcp.ippoan.org/mcp`（claude.ai / Claude Code のカスタムコネクタ URL）
- 稼働 worker: `gmail-mcp-staging`（staging=prod パターン、ci-dashboard と同じ）

## 設計原則

- **send 系ツールは実装しない。** `messages.send` / `drafts.send` に到達する経路をサーバーに一切置かない。スコープ上は送信可能なトークン（`gmail.modify`）だが、MCP サーバーが送信エンドポイントを公開しないため Claude 経由の送信経路が存在しない。CI の snapshot テストが send 系ツール名の混入を弾く
- **削除系は `delete_draft`（下書き）のみ。** メッセージ/スレッドの完全削除はもちろん、TRASH / SPAM への移動も `modify_labels` が拒否する（Gmail API に届く前にバリデーション）
- **マルチアカウント**: 全ツールに `account?: string`（エイリアス、省略時 `"default"`）。公式 Gmail コネクタの「1 アカウントのみ」制限を超えるのが動機の一つ
- **メール本文は信頼しない**: 本文経由の prompt injection に対する最大の緩和策が「送信不可」設計そのもの。下書きは必ず人間が Gmail UI で確認してから送信する

## ツール（v1）

| ツール | 区分 | 説明 |
|---|---|---|
| `list_accounts` | read | 登録アカウント一覧。`check_auth: true` で refresh token の生存確認 |
| `search_threads` | read | Gmail 検索構文で検索（default 10 / 上限 50 件） |
| `get_thread` / `get_message` | read | 本文取得。text/plain 優先 → HTML タグ除去。ISO-2022-JP 等対応。添付はメタのみ |
| `list_labels` | read | ラベル一覧 |
| `create_draft` | write | 下書き作成。`thread_id` で返信下書き（In-Reply-To / References 自動、Re: 補完） |
| `list_drafts` | read | 下書き一覧 |
| `delete_draft` | write | **唯一の削除系** |
| `modify_labels` | write | ラベル付け外し。アーカイブ = `remove: ["INBOX"]`。TRASH / SPAM は拒否 |
| `ping` | read | 疎通確認 |

## 認証の2層構造

```
Claude ──[① binding_jwt]──▶ gmail-mcp ──[② Google OAuth]──▶ Gmail API
```

1. **コネクタ認証** — auth-worker（`AUTH_WORKER_ORIGIN=https://auth-staging.ippoan.org` が実稼働 AS）の binding_jwt を `/mcp/introspect` へ転送して検証。worker 側に shared secret 不要・fail-closed。CF Access は host を `me` で保護し `/mcp` のみ bypassAll（org 標準パターン）
2. **Gmail 認可** — ブラウザで `/oauth/start?alias=<name>` → Google 同意（`gmail.modify`, offline+consent）→ `/oauth/callback` が refresh_token を KV に保存。CSRF は KV の state nonce（TTL 600s・one-shot）

### トークンの置き場

| 値 | 性質 | 置き場 |
|---|---|---|
| client_secret | 静的 | Secrets Store binding `GOOGLE_CLIENT_SECRET`（GCP SM `gmail-mcp-google-client-secret` が source of truth、secrets-inventory で同期） |
| refresh_token | 動的（テストモードで 7 日失効 → callback が再保存） | KV `gmail-mcp-accounts`（ci-dashboard が GitHub OAuth token を KV に置くのと同じ使い分け） |

access_token は保存せず都度 refresh（1h 有効）。

### 7 日失効の運用（テストモード、許容済み）

OAuth 同意画面はテストモードのまま運用する（本番公開・検証手続きはしない）。refresh token が失効すると各ツールが再認証 URL（`/oauth/start?alias=<name>`）を返すので、ブラウザで 1 分の再認可で復帰する。

## アカウントの追加

1. Google Cloud Console → OAuth 同意画面（テストモード）の **テストユーザー**に対象 Gmail を追加
2. ブラウザで `https://gmail-mcp.ippoan.org/oauth/start?alias=<新しいalias>` を開いて認可
3. `list_accounts` で確認。以降ツールの `account: "<alias>"` で指定

## セットアップ（新規に立てる場合の要点）

- GCP: プロジェクトに Gmail API 有効化、OAuth クライアント（Web 型、redirect URI `https://gmail-mcp.ippoan.org/oauth/callback`）
- secrets: `gmail-mcp-google-client-secret` を GCP SM に投入 → secrets-inventory `sync_from_gcp` で CF Secrets Store へ
- CF Access: host を `me` で保護 + `/mcp` を bypassAll
- auth-worker: `MCP_RESOURCE_ORIGINS_ALLOWLIST` に `https://gmail-mcp.ippoan.org` を登録（slug = `gmail-mcp`）
- deploy は CI（`frontend-ci.yml` worker 型、PR ごとに staging deploy → auto-merge）

## 開発

```sh
npm install         # 要 NODE_AUTH_TOKEN (read:packages)。無い場合は下記
npm run typecheck
npm test
npx wrangler dev
```

ローカルに GitHub Packages の token が無い場合は、`@ippoan/mcp-cf-workers` が
TS ソース直配布（public repo）であることを利用して一時的に git spec で入れる:

```sh
npm pkg set "dependencies.@ippoan/mcp-cf-workers=github:ippoan/mcp-cf-workers"
npm install
# 作業後、commit 前に戻す
npm pkg set "dependencies.@ippoan/mcp-cf-workers=dev"
```

注意（stateless MCP）: deploy でツールが増えても接続済みコネクタの `tools/list` は
固定のまま。コネクタを再接続すると反映される。
