interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_ALLOWED_CHANNEL_ID: string;
  ADMIN_TOKEN: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GEMINI_FALLBACK_MODEL: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  MAX_OUTPUT_TOKENS: string;
  SYSTEM_PROMPT: string;
  GEMINI_QUEUE: Queue<AiJob>;
}

interface DiscordOption { name: string; value?: string | number | boolean }
interface DiscordUser { id: string; username: string; global_name?: string | null }
interface DiscordInteraction {
  application_id: string;
  type: number;
  token: string;
  channel_id?: string;
  data?: { name?: string; options?: DiscordOption[] };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
}
interface AiJob {
  applicationId: string;
  interactionToken: string;
  prompt: string;
  displayName: string;
  provider: "gemini" | "openrouter";
}
interface RegisterRequest { guildId?: string }
interface GeminiResult { text: string; model: string; usedFallback: boolean }

const DISCORD_API = "https://discord.com/api/v10";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "dgc",
        geminiModel: env.GEMINI_MODEL,
        geminiFallbackModel: env.GEMINI_FALLBACK_MODEL,
        openRouterModel: env.OPENROUTER_MODEL,
        geminiKeyConfigured: Boolean(env.GEMINI_API_KEY),
        openRouterKeyConfigured: Boolean(env.OPENROUTER_API_KEY),
        channelRestrictionConfigured: Boolean(env.DISCORD_ALLOWED_CHANNEL_ID),
        queueConfigured: Boolean(env.GEMINI_QUEUE),
      });
    }
    if (request.method === "GET" && url.pathname === "/setup") {
      return new Response(setupPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }
    if (request.method === "POST" && url.pathname === "/setup/register") return registerCommands(request, env);
    if (request.method === "POST" && url.pathname === "/discord") return handleDiscordInteraction(request, env);
    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch<AiJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processAiJob(message.body, env);
        message.ack();
      } catch (error) {
        console.error("Queue job failed", error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, AiJob>;

async function handleDiscordInteraction(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();
  if (!signature || !timestamp || !(await verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))) {
    return new Response("Invalid request signature", { status: 401 });
  }

  let interaction: DiscordInteraction;
  try { interaction = JSON.parse(body) as DiscordInteraction; }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  if (interaction.type === 1) return Response.json({ type: 1 });
  const command = interaction.data?.name;
  if (interaction.type !== 2 || (command !== "ask" && command !== "askd")) return discordMessage("Unsupported command.", true);

  const allowedChannelId = env.DISCORD_ALLOWED_CHANNEL_ID?.trim();
  if (!allowedChannelId) return discordMessage("⚠️ Bot管理者が利用可能チャンネルをまだ設定していません。", true);
  if (interaction.channel_id !== allowedChannelId) return discordMessage(`このBotは <#${allowedChannelId}> でのみ使用できます。`, true);

  const prompt = getStringOption(interaction, "prompt");
  if (!prompt) return discordMessage("質問内容が空です。", true);

  const provider = command === "askd" ? "openrouter" : "gemini";
  if (provider === "openrouter" && !env.OPENROUTER_API_KEY) return discordMessage("⚠️ OPENROUTER_API_KEY が未設定です。", true);
  if (provider === "gemini" && !env.GEMINI_API_KEY) return discordMessage("⚠️ GEMINI_API_KEY が未設定です。", true);

  const user = interaction.member?.user ?? interaction.user;
  const displayName = user?.global_name || user?.username || "Discord user";
  try {
    await env.GEMINI_QUEUE.send({ applicationId: interaction.application_id, interactionToken: interaction.token, prompt, displayName, provider });
  } catch (error) {
    console.error("Failed to enqueue AI job", error);
    return discordMessage("⚠️ 処理キューへの登録に失敗しました。", true);
  }
  return new Response(JSON.stringify({ type: 5 }), { status: 200, headers: JSON_HEADERS });
}

async function processAiJob(job: AiJob, env: Env): Promise<void> {
  try {
    if (job.provider === "openrouter") {
      const model = env.OPENROUTER_MODEL || "deepseek/deepseek-r1-0528:free";
      await editOriginalResponse(job, `🤔 Thinking… 使用モデル：\`${model}\`（OpenRouter）`);
      const text = await callOpenRouter(model, job, env);
      const chunks = splitDiscordMessage(`> ✅ 使用モデル：\`${model}\`（OpenRouter）\n\n${text}`);
      await editOriginalResponse(job, chunks[0]);
      for (const chunk of chunks.slice(1)) await createFollowup(job, chunk);
      return;
    }

    await editOriginalResponse(job, `🤔 Thinking… 使用モデル：\`${env.GEMINI_MODEL || "gemini-3.5-flash"}\``);
    const result = await callGeminiWithFallback(job, env);
    const prefix = result.usedFallback
      ? `> ⚠️ フォールバックモデル \`${result.model}\` を使用しました。\n\n`
      : `> ✅ 使用モデル：\`${result.model}\`\n\n`;
    const chunks = splitDiscordMessage(prefix + result.text);
    await editOriginalResponse(job, chunks[0]);
    for (const chunk of chunks.slice(1)) await createFollowup(job, chunk);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await editOriginalResponse(job, `⚠️ AIへの問い合わせに失敗しました。\n\`${escapeInlineCode(message).slice(0, 1500)}\``);
  }
}

async function callOpenRouter(model: string, job: AiJob, env: Env): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("OpenRouter request timed out"), 120_000);
  try {
    const response = await fetch(OPENROUTER_API, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://dgc.sakus.org",
        "X-Title": "dgc Discord Bot",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: env.SYSTEM_PROMPT },
          { role: "user", content: `Discord display name: ${job.displayName}\n\n${job.prompt}` },
        ],
        max_tokens: clampInteger(Number(env.MAX_OUTPUT_TOKENS || 2048), 256, 8192),
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenRouter API ${response.status}: ${compactError(raw)}`);
    const payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("OpenRouter returned no text");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiWithFallback(job: AiJob, env: Env): Promise<GeminiResult> {
  const primary = env.GEMINI_MODEL || "gemini-3.5-flash";
  const fallback = env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite";
  try {
    return { text: await callGemini(primary, job, env), model: primary, usedFallback: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Gemini API (429|500|503|504):/.test(message) || fallback === primary) throw error;
    await editOriginalResponse(job, `🤔 Thinking… 使用モデル：\`${fallback}\`\nフォールバックを使用中`);
    return { text: await callGemini(fallback, job, env), model: fallback, usedFallback: true };
  }
}

async function callGemini(model: string, job: AiJob, env: Env): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Gemini request timed out"), 120_000);
  try {
    const response = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: env.SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `Discord display name: ${job.displayName}\n\n${job.prompt}` }] }],
        generationConfig: { maxOutputTokens: clampInteger(Number(env.MAX_OUTPUT_TOKENS || 2048), 256, 8192), temperature: 0.7 },
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Gemini API ${response.status}: ${compactError(raw)}`);
    const payload = JSON.parse(raw) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini returned no text");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function registerCommands(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let input: RegisterRequest;
  try { input = (await request.json()) as RegisterRequest; }
  catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  const guildId = input.guildId?.trim();
  if (guildId && !/^\d{17,20}$/.test(guildId)) return Response.json({ ok: false, error: "Guild ID must be a Discord snowflake." }, { status: 400 });
  const route = guildId ? `/applications/${env.DISCORD_APPLICATION_ID}/guilds/${guildId}/commands` : `/applications/${env.DISCORD_APPLICATION_ID}/commands`;
  const commandOption = [{ name: "prompt", description: "質問内容", type: 3, required: true, max_length: 4000 }];
  const response = await fetch(`${DISCORD_API}${route}`, {
    method: "PUT",
    headers: { ...JSON_HEADERS, authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify([
      { name: "ask", description: "Geminiに質問します", type: 1, options: commandOption },
      { name: "askd", description: "DeepSeekに質問します（OpenRouter無料モデル）", type: 1, options: commandOption },
    ]),
  });
  const text = await response.text();
  if (!response.ok) return Response.json({ ok: false, error: `Discord API ${response.status}: ${compactError(text)}` }, { status: response.status });
  return Response.json({ ok: true, message: guildId ? "テストサーバーへ /ask と /askd を登録しました。" : "グローバルに /ask と /askd を登録しました。" });
}

function setupPage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dgc setup</title><style>:root{font-family:system-ui,sans-serif;color-scheme:dark;background:#111;color:#eee}body{margin:0;display:grid;place-items:center;min-height:100vh;padding:20px}.card{width:min(560px,100%);background:#1b1b1b;border:1px solid #333;border-radius:18px;padding:24px;box-sizing:border-box}label{display:block;margin:16px 0 6px}input,button{width:100%;box-sizing:border-box;border-radius:10px;border:1px solid #444;padding:12px;font:inherit}input{background:#111;color:#fff}button{margin-top:16px;background:#5865f2;color:white;border:0;font-weight:700}.result{white-space:pre-wrap;margin-top:16px;padding:12px;background:#111;border-radius:10px}</style></head><body><main class="card"><h1>dgc セットアップ</h1><form id="form"><label>ADMIN_TOKEN</label><input id="token" type="password" required><label>テストサーバーID（空欄ならグローバル）</label><input id="guild" inputmode="numeric"><button>/ask と /askd を登録</button></form><div id="result" class="result"></div></main><script>const f=document.getElementById('form'),r=document.getElementById('result');f.addEventListener('submit',async e=>{e.preventDefault();r.textContent='登録中…';try{const x=await fetch('/setup/register',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+document.getElementById('token').value},body:JSON.stringify({guildId:document.getElementById('guild').value.trim()||undefined})});const d=await x.json();r.textContent=d.ok?'✅ '+d.message:'❌ '+(d.error||'失敗');}catch(err){r.textContent='❌ '+String(err);}});</script></body></html>`;
}

function discordMessage(content: string, ephemeral: boolean): Response { return Response.json({ type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } }); }
async function verifyDiscordRequest(body: string, signatureHex: string, timestamp: string, publicKeyHex: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(signatureHex), new TextEncoder().encode(timestamp + body));
  } catch { return false; }
}
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw new Error("Invalid hexadecimal value");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}
function getStringOption(interaction: DiscordInteraction, name: string): string | undefined {
  const value = interaction.data?.options?.find((option) => option.name === name)?.value;
  return typeof value === "string" ? value.trim() : undefined;
}
async function editOriginalResponse(job: AiJob, content: string): Promise<void> {
  const response = await fetch(`${DISCORD_API}/webhooks/${job.applicationId}/${job.interactionToken}/messages/@original`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
  if (!response.ok) throw new Error(`Discord edit failed (${response.status}): ${compactError(await response.text())}`);
}
async function createFollowup(job: AiJob, content: string): Promise<void> {
  const response = await fetch(`${DISCORD_API}/webhooks/${job.applicationId}/${job.interactionToken}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
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
  return chunks.length ? chunks : ["(empty response)"];
}
function compactError(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 1000); }
function escapeInlineCode(value: string): string { return value.replace(/`/g, "ˋ"); }
function clampInteger(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min; }
