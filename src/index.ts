interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_ALLOWED_CHANNEL_ID: string;
  ADMIN_TOKEN: string;
  GCP_API_KEY: string;
  GCP_PROJECT_ID: string;
  GCP_LOCATION: string;
  GEMINI_MODEL: string;
  MAX_OUTPUT_TOKENS: string;
  SYSTEM_PROMPT: string;
}

interface DiscordOption {
  name: string;
  value?: string | number | boolean;
}

interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  channel_id?: string;
  data?: { name?: string; options?: DiscordOption[] };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

interface RegisterRequest {
  guildId?: string;
}

const DISCORD_API = "https://discord.com/api/v10";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "dgc",
        model: env.GEMINI_MODEL,
        channelRestrictionConfigured: Boolean(env.DISCORD_ALLOWED_CHANNEL_ID),
      });
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      return new Response(setupPage(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/setup/register") {
      return registerCommand(request, env);
    }

    if (request.method !== "POST" || url.pathname !== "/discord") {
      return new Response("Not found", { status: 404 });
    }

    return handleDiscordInteraction(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function handleDiscordInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();

  if (!signature || !timestamp || !(await verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))) {
    return new Response("Invalid request signature", { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (interaction.type === 1) return Response.json({ type: 1 });

  if (interaction.type !== 2 || interaction.data?.name !== "ask") {
    return Response.json({ type: 4, data: { content: "Unsupported command.", flags: 64 } });
  }

  const allowedChannelId = env.DISCORD_ALLOWED_CHANNEL_ID?.trim();
  if (!allowedChannelId) {
    return Response.json({
      type: 4,
      data: {
        content: "⚠️ Bot管理者が利用可能チャンネルをまだ設定していません。",
        flags: 64,
      },
    });
  }

  if (interaction.channel_id !== allowedChannelId) {
    return Response.json({
      type: 4,
      data: {
        content: `このBotは <#${allowedChannelId}> でのみ使用できます。`,
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
  }

  const prompt = getStringOption(interaction, "prompt");
  if (!prompt) {
    return Response.json({ type: 4, data: { content: "質問内容が空です。", flags: 64 } });
  }

  ctx.waitUntil(generateAndReply(interaction, prompt, env));
  return Response.json({ type: 5 });
}

async function registerCommand(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let input: RegisterRequest;
  try {
    input = (await request.json()) as RegisterRequest;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const guildId = input.guildId?.trim();
  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    return Response.json({ ok: false, error: "Guild ID must be a Discord snowflake." }, { status: 400 });
  }

  if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_BOT_TOKEN) {
    return Response.json(
      { ok: false, error: "DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN is missing." },
      { status: 500 },
    );
  }

  const route = guildId
    ? `/applications/${env.DISCORD_APPLICATION_ID}/guilds/${guildId}/commands`
    : `/applications/${env.DISCORD_APPLICATION_ID}/commands`;

  const response = await fetch(`${DISCORD_API}${route}`, {
    method: "PUT",
    headers: {
      ...JSON_HEADERS,
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    },
    body: JSON.stringify([
      {
        name: "ask",
        description: "Geminiに質問します",
        type: 1,
        options: [
          {
            name: "prompt",
            description: "質問内容",
            type: 3,
            required: true,
            max_length: 4000,
          },
        ],
      },
    ]),
  });

  const text = await response.text();
  if (!response.ok) {
    return Response.json(
      { ok: false, error: `Discord API ${response.status}: ${compactError(text)}` },
      { status: response.status },
    );
  }

  return Response.json({
    ok: true,
    scope: guildId ? "guild" : "global",
    guildId: guildId || null,
    message: guildId ? "テストサーバーへ /ask を登録しました。" : "グローバルに /ask を登録しました。",
  });
}

function setupPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dgc setup</title>
<style>
:root{font-family:system-ui,sans-serif;color-scheme:dark;background:#111;color:#eee}body{margin:0;display:grid;place-items:center;min-height:100vh;padding:20px}.card{width:min(560px,100%);background:#1b1b1b;border:1px solid #333;border-radius:18px;padding:24px;box-sizing:border-box}h1{margin-top:0}label{display:block;margin:16px 0 6px}input,button{width:100%;box-sizing:border-box;border-radius:10px;border:1px solid #444;padding:12px;font:inherit}input{background:#111;color:#fff}button{margin-top:16px;background:#5865f2;color:white;border:0;font-weight:700;cursor:pointer}button:disabled{opacity:.6;cursor:wait}.muted{color:#aaa;font-size:.92rem}.result{white-space:pre-wrap;margin-top:16px;padding:12px;background:#111;border-radius:10px;min-height:24px}</style>
</head>
<body>
<main class="card">
<h1>dgc セットアップ</h1>
<p class="muted">Cloudflareに保存したADMIN_TOKENを入力し、Discordの/askコマンドを登録します。値はブラウザ内だけで使用され、保存されません。</p>
<form id="form">
<label for="token">ADMIN_TOKEN</label>
<input id="token" type="password" autocomplete="off" required>
<label for="guild">テストサーバーID（空欄ならグローバル登録）</label>
<input id="guild" inputmode="numeric" pattern="[0-9]*" placeholder="例: 123456789012345678">
<button id="submit" type="submit">/ask を登録</button>
</form>
<div id="result" class="result" aria-live="polite"></div>
</main>
<script>
const form=document.getElementById('form');const button=document.getElementById('submit');const result=document.getElementById('result');
form.addEventListener('submit',async(event)=>{event.preventDefault();button.disabled=true;result.textContent='登録中…';try{const response=await fetch('/setup/register',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+document.getElementById('token').value},body:JSON.stringify({guildId:document.getElementById('guild').value.trim()||undefined})});const data=await response.json();result.textContent=data.ok?'✅ '+data.message:'❌ '+(data.error||'登録に失敗しました');}catch(error){result.textContent='❌ '+String(error);}finally{button.disabled=false;}});
</script>
</body>
</html>`;
}

async function verifyDiscordRequest(body: string, signatureHex: string, timestamp: string, publicKeyHex: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(timestamp + body),
    );
  } catch (error) {
    console.error("Discord signature verification failed", error);
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw new Error("Invalid hexadecimal value");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  return bytes;
}

function getStringOption(interaction: DiscordInteraction, name: string): string | undefined {
  const value = interaction.data?.options?.find((option) => option.name === name)?.value;
  return typeof value === "string" ? value.trim() : undefined;
}

async function generateAndReply(interaction: DiscordInteraction, prompt: string, env: Env): Promise<void> {
  try {
    const answer = await callGemini(prompt, interaction, env);
    const chunks = splitDiscordMessage(answer);
    await editOriginalResponse(interaction, chunks[0] ?? "Gemini returned an empty response.");
    for (const chunk of chunks.slice(1)) await createFollowup(interaction, chunk);
  } catch (error) {
    console.error("Generation failed", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    await editOriginalResponse(interaction, `⚠️ Geminiへの問い合わせに失敗しました。\n\`${escapeInlineCode(message).slice(0, 1500)}\``);
  }
}

async function callGemini(prompt: string, interaction: DiscordInteraction, env: Env): Promise<string> {
  const location = env.GCP_LOCATION || "global";
  const model = env.GEMINI_MODEL || "gemini-3.1-pro-preview";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(env.GCP_PROJECT_ID)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
  const user = interaction.member?.user ?? interaction.user;
  const displayName = user?.global_name || user?.username || "Discord user";
  const maxOutputTokens = clampInteger(Number(env.MAX_OUTPUT_TOKENS || 2048), 256, 8192);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Gemini request timed out"), 25_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-goog-api-key": env.GCP_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: env.SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `Discord display name: ${displayName}\n\n${prompt}` }] }],
        generationConfig: { maxOutputTokens, temperature: 0.7 },
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) throw new Error(`Vertex AI ${response.status}: ${compactError(raw)}`);
    const payload = JSON.parse(raw) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
    };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error(payload.promptFeedback?.blockReason ? `Response blocked: ${payload.promptFeedback.blockReason}` : "Gemini returned no text");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function editOriginalResponse(interaction: DiscordInteraction, content: string): Promise<void> {
  const response = await fetch(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) throw new Error(`Discord edit failed (${response.status}): ${compactError(await response.text())}`);
}

async function createFollowup(interaction: DiscordInteraction, content: string): Promise<void> {
  const response = await fetch(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) throw new Error(`Discord follow-up failed (${response.status}): ${compactError(await response.text())}`);
}

function splitDiscordMessage(text: string, limit = 1950): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const breakAt = Math.max(candidate.lastIndexOf("\n\n"), candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const index = breakAt > limit * 0.55 ? breakAt : limit;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : ["(empty response)"];
}

function compactError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "ˋ");
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
