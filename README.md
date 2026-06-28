# dgc

Cloudflare Workers 上で動作する、Discord `/ask` コマンド対応の Vertex AI Gemini チャットボットです。

ランタイム依存を持たない軽量な TypeScript 実装で、Discord の Ed25519 署名検証、3秒以内の遅延応答、Vertex AI 呼び出し、Discord の2000文字制限に合わせた分割送信を行います。

## 構成

```text
Discord /ask
    ↓
Cloudflare Worker
    ↓
Vertex AI Gemini 3.1 Pro
    ↓
Discord の元メッセージを更新
```

## 必要なもの

- Cloudflare アカウント
- Discord Application / Bot
- Vertex AI API を有効化した Google Cloud プロジェクト
- サービスアカウントに紐づけた Vertex AI 用 API キー
- Node.js 20 以降

## 1. ローカル準備

```bash
git clone https://github.com/sakusdev/dgc.git
cd dgc
npm install
```

## 2. Cloudflare にログイン

```bash
npx wrangler login
```

## 3. Secrets を登録

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put GCP_API_KEY
npx wrangler secret put GCP_PROJECT_ID
```

値の取得場所:

- `DISCORD_PUBLIC_KEY`: Discord Developer Portal → General Information → Public Key
- `GCP_API_KEY`: Google Cloud Console で発行した Vertex AI 用 API キー
- `GCP_PROJECT_ID`: Google Cloud のプロジェクト ID。表示名ではありません

通常設定は `wrangler.toml` にあります。

```toml
GCP_LOCATION = "global"
GEMINI_MODEL = "gemini-3.1-pro-preview"
MAX_OUTPUT_TOKENS = "2048"
```

利用可能なモデル ID が変わった場合は `GEMINI_MODEL` を更新してください。

## 4. デプロイ

```bash
npm run typecheck
npm run deploy
```

デプロイ後に次のような URL が表示されます。

```text
https://dgc.<your-subdomain>.workers.dev
```

ヘルスチェック:

```text
https://dgc.<your-subdomain>.workers.dev/health
```

Discord の Interactions Endpoint URL:

```text
https://dgc.<your-subdomain>.workers.dev/discord
```

Discord Developer Portal → General Information → Interactions Endpoint URL に設定してください。

## 5. `/ask` コマンドを登録

ローカル環境で次を設定します。

```bash
export DISCORD_APPLICATION_ID="Discord Application ID"
export DISCORD_BOT_TOKEN="Discord Bot Token"
```

テスト用サーバーに即時登録する場合:

```bash
export DISCORD_GUILD_ID="Discord Server ID"
npm run register
```

全サーバー向けのグローバルコマンドとして登録する場合:

```bash
unset DISCORD_GUILD_ID
npm run register
```

グローバルコマンドは反映に時間がかかる場合があります。

## 6. Bot をサーバーへ招待

Discord Developer Portal → OAuth2 → URL Generator で次を選択します。

- Scopes: `bot`, `applications.commands`
- Bot Permissions: `Send Messages`, `Use Slash Commands`

生成された URL から Bot を招待してください。

## ローカル開発

`.dev.vars` を作成します。このファイルは Git 管理されません。

```dotenv
DISCORD_PUBLIC_KEY=...
GCP_API_KEY=...
GCP_PROJECT_ID=...
```

起動:

```bash
npm run dev
```

Discord は公開 HTTPS URL を要求するため、実際の Interaction テストではデプロイ済み Worker を使う方が簡単です。

## 無料枠について

Cloudflare Workers Free で小規模運用できます。Gemini 3.1 Pro 自体は常設の無料モデルではないため、Vertex AI の Google Cloud 無料トライアルクレジット内では実質無料ですが、クレジット終了後はモデル利用料金が発生します。

完全な常設無料運用を優先する場合は、`GEMINI_MODEL` を無料枠対象の Flash 系モデルへ変更してください。

## 現在の制約

- Discord Gateway へ常時接続しないため、通常メッセージやメンション監視ではなく `/ask` 方式です
- 会話履歴はまだ保存しません
- Worker は Discord に即時 defer を返した後、最大25秒で Gemini 呼び出しを打ち切ります
- 非常に長い応答は複数の Discord メッセージへ分割されます

## セキュリティ

- API キーや Bot Token をソースコードへ書かないでください
- GitHub Actions や Cloudflare では必ず Secret として保存してください
- Worker は Discord の Ed25519 署名を検証します
- Gemini の出力による意図しないメンションを防ぐため、Discord の `allowed_mentions` を無効化しています
