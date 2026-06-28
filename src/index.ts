interface Env {
  DISCORD_PUBLIC_KEY: string;
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
  guild_id?: string;
  data?: {
    name?: string;
    options?: DiscordOption[];
  };
  member?: {
    user?: {
      id: string;
      username: string;
      global_name?: string | null;
    };
  };
  user?: {
    id: string;
    username: string;
    global_name?: string | null;
  };
}

const DISCORD_API = "https://discord.com/api/v10";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "dgc", model: env.GEMINI_MODEL });
    }

    if (request.method !== "POST" || url.pathname !== "/discord") {
      return new Response("Not found", { status: 404 });
    }

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

    // Discord endpoint verification ping.
    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    if (interaction.type !== 2 || interaction.data?.name !== "ask") {
      return Response.json({
        type: 4,
        data: { content: "Unsupported command.", flags: 64 },
      });
    }

    const prompt = getStringOption(interaction, "prompt");
    if (!prompt) {
      return Response.json({
        type: 4,
        data: { content: "質問内容が空です。", flags: 64 },
      });
    }

    // Acknowledge inside Discord's three-second deadline, then finish in the background.
    ctx.waitUntil(generateAndReply(interaction, prompt, env));
    return Response.json({ type: 5 });
  },
} satisfies ExportedHandler<Env>;

async function verifyDiscordRequest(
  body: string,
  signatureHex: string,
  timestamp: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );

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
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("Invalid hexadecimal value");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
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
    for (const chunk of chunks.slice(1)) {
      await createFollowup(interaction, chunk);
    }
  } catch (error) {
    console.error("Generation failed", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    await editOriginalResponse(interaction, `⚠️ Geminiへの問い合わせに失敗しました。\n\`${escapeInlineCode(message).slice(0, 1500)}\``);
  }
}

async function callGemini(prompt: string, interaction: DiscordInteraction, env: Env): Promise<string> {
  const location = env.GCP_LOCATION || "global";
  const model = env.GEMINI_MODEL || "gemini-3.1-pro-preview";
  const endpoint =
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(env.GCP_PROJECT_ID)}` +
    `/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

  const user = interaction.member?.user ?? interaction.user;
  const displayName = user?.global_name || user?.username || "Discord user";
  const maxOutputTokens = clampInteger(Number(env.MAX_OUTPUT_TOKENS || 2048), 256, 8192);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Gemini request timed out"), 25_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        "x-goog-api-key": env.GCP_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: env.SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Discord display name: ${displayName}\n\n${prompt}`,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens,
          temperature: 0.7,
        },
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Vertex AI ${response.status}: ${compactError(raw)}`);
    }

    const payload = JSON.parse(raw) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
    };

    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!text) {
      const reason = payload.promptFeedback?.blockReason;
      throw new Error(reason ? `Response blocked: ${reason}` : "Gemini returned no text");
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function editOriginalResponse(interaction: DiscordInteraction, content: string): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });

  if (!response.ok) {
    throw new Error(`Discord edit failed (${response.status}): ${compactError(await response.text())}`);
  }
}

async function createFollowup(interaction: DiscordInteraction, content: string): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`;
  const response = await fetch(url, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });

  if (!response.ok) {
    throw new Error(`Discord follow-up failed (${response.status}): ${compactError(await response.text())}`);
  }
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
