# dgc

Cloudflare Workers 上で動作する、Discord `/ask` コマンド対応の Vertex AI Gemini チャットボットです。

セットアップから運用までブラウザだけで完結します。ローカルPC、Node.js、Wrangler CLIの実行は不要です。

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

## 1. CloudflareでGitHub連携デプロイ

Cloudflare Dashboardで次へ進みます。

```text
Workers & Pages
→ Create
→ Import a repository
→ sakusdev/dgc
```

設定:

```text
Production branch: main
Root directory: /
Build command: npm run deploy
```

GitHubの`main`へ変更が入ると自動で再デプロイされます。

## 2. CloudflareにSecretを登録

Workerの Settings → Variables and Secrets で、以下をすべて **Secret** として登録します。

| 名前 | 値 |
|---|---|
| `DISCORD_PUBLIC_KEY` | Discord Developer Portal → General Information → Public Key |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → General Information → Application ID |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → Bot → Reset Token / Copy |
| `ADMIN_TOKEN` | 自分で決めた長いランダムな文字列 |
| `GCP_API_KEY` | Google Cloudで発行したVertex AI用APIキー |
| `GCP_PROJECT_ID` | Google CloudのプロジェクトID。プロジェクト番号ではありません |

`ADMIN_TOKEN` は `/setup` 管理画面からコマンドを登録するための合言葉です。最低でも32文字程度のランダム文字列を推奨します。

通常設定は `wrangler.toml` にあります。

```toml
GCP_LOCATION = "global"
GEMINI_MODEL = "gemini-3.1-pro-preview"
MAX_OUTPUT_TOKENS = "2048"
```

## 3. DiscordのInteractions Endpoint URLを設定

デプロイ後のWorker URLが次の場合:

```text
https://dgc.<your-subdomain>.workers.dev
```

Discord Developer Portal → General Information → Interactions Endpoint URL に次を設定します。

```text
https://dgc.<your-subdomain>.workers.dev/discord
```

保存時にDiscordから検証リクエストが送信されます。成功すればWorkerの署名検証も正常です。

## 4. ブラウザから `/ask` を登録

ブラウザで次を開きます。

```text
https://dgc.<your-subdomain>.workers.dev/setup
```

画面で入力するもの:

- `ADMIN_TOKEN`: Cloudflareへ保存した値
- テストサーバーID: すぐ試す場合だけ入力

テストサーバーIDを入力すると、そのDiscordサーバーだけへ即時登録します。空欄で実行するとグローバルコマンドとして登録します。

これでローカルコマンドの実行は不要です。

## 5. BotをDiscordサーバーへ招待

Discord Developer Portal → OAuth2 → URL Generator で次を選択します。

```text
Scopes:
- bot
- applications.commands

Bot Permissions:
- Send Messages
- Use Slash Commands
```

生成されたURLをブラウザで開き、Botをサーバーへ追加します。

## 動作確認

ヘルスチェック:

```text
https://dgc.<your-subdomain>.workers.dev/health
```

成功例:

```json
{"ok":true,"service":"dgc","model":"gemini-3.1-pro-preview"}
```

Discordで:

```text
/ask prompt: こんにちは
```

## 無料枠について

Cloudflare Workers Freeで小規模運用できます。Gemini 3.1 Pro自体は常設無料ではないため、Google Cloud無料トライアルクレジット内では実質無料ですが、クレジット終了後はモデル利用料金が発生します。

完全な常設無料運用を優先する場合は、`GEMINI_MODEL` を無料枠対象のFlash系モデルへ変更してください。

## 現在の制約

- Discord Gatewayへ常時接続しないため、通常メッセージやメンション監視ではなく`/ask`方式です
- 会話履歴はまだ保存しません
- WorkerはDiscordへ即時deferを返した後、最大25秒でGemini呼び出しを打ち切ります
- 非常に長い応答は複数のDiscordメッセージへ分割されます

## セキュリティ

- APIキーやBot TokenをGitHubへ保存しないでください
- Cloudflareでは必ずSecretとして保存してください
- `/setup/register` は `ADMIN_TOKEN` が一致しない限り実行できません
- `/setup` へ入力した `ADMIN_TOKEN` はブラウザに保存されません
- WorkerはDiscordのEd25519署名を検証します
- Gemini出力による意図しないメンションを防ぐため、Discordの`allowed_mentions`を無効化しています
