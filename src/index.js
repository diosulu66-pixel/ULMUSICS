require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const { handleCommand } = require('./commandHandler');
const { handleVoiceStateUpdate } = require('./voiceManager');
const { handleButtonInteraction } = require('./musicPlayer');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// Shared state across the bot
client.queues = new Map();      // guildId -> queue array
client.connections = new Map(); // guildId -> VoiceConnection
client.players = new Map();     // guildId -> AudioPlayer
client.recorders = new Map();   // guildId -> recording state
client.embedMessages = new Map(); // guildId -> player embed message

client.once('ready', () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  client.user.setActivity('🎵 Música | -help', { type: 0 });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('-')) return;
  await handleCommand(client, message);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  await handleVoiceStateUpdate(client, oldState, newState);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  await handleButtonInteraction(client, interaction);
});

client.on('error', (err) => console.error('Discord client error:', err));

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN not found in environment variables!');
  process.exit(1);
}

client.login(TOKEN);
