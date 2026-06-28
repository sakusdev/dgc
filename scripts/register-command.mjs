const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN before running this script.");
  process.exit(1);
}

const commands = [
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
];

const route = guildId
  ? `applications/${applicationId}/guilds/${guildId}/commands`
  : `applications/${applicationId}/commands`;

const response = await fetch(`https://discord.com/api/v10/${route}`, {
  method: "PUT",
  headers: {
    authorization: `Bot ${botToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

const body = await response.text();
if (!response.ok) {
  console.error(`Discord API ${response.status}: ${body}`);
  process.exit(1);
}

console.log(`Registered /ask ${guildId ? `for guild ${guildId}` : "globally"}.`);
console.log(body);
