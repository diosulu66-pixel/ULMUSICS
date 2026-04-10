process.env.OPUS_SCRIPT = "1"; // 🔥 FORZAR OPUSSCRIPT

require('dotenv').config();
const fs = require('fs');
const { exec } = require('child_process');
const prism = require('prism-media');

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    EndBehaviorType
} = require('@discordjs/voice');

const play = require('play-dl');
const { createClient } = require('@supabase/supabase-js');

let scReady = false;

// ✅ SoundCloud FIX
async function initSoundCloud() {
    const client_id = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id } });
    scReady = true;
    console.log("✅ SoundCloud listo");
}
initSoundCloud();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

let queue = [];
let player = createAudioPlayer();
let connection = null;
let currentChannel = null;
let timeout = null;

// READY
client.once('clientReady', () => {
    console.log(`✅ Bot listo como ${client.user.tag}`);
});

// 🎵 PLAY
async function playMusic(channel) {
    if (!queue.length) return;

    const song = queue[0];

    try {
        const stream = await play.stream(song.url, {
            discordPlayerCompatibility: true
        });

        const resource = createAudioResource(stream.stream, {
            inputType: stream.type
        });

        player.play(resource);
        connection.subscribe(player);

        const embed = new EmbedBuilder()
            .setTitle('🎵 Reproduciendo')
            .setDescription(song.title);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pause').setLabel('⏸️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('resume').setLabel('▶️').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('skip').setLabel('⏭️').setStyle(ButtonStyle.Danger)
        );

        channel.send({ embeds: [embed], components: [row] });

    } catch (err) {
        console.error("❌ Error reproduciendo:", err);
        queue.shift();
        playMusic(channel);
    }
}

player.on(AudioPlayerStatus.Idle, () => {
    queue.shift();
    playMusic(currentChannel);
});

// 🎤 GRABACIÓN SEGURA (NO CRASHEA)
function startRecording(connection) {
    try {
        const receiver = connection.receiver;

        const opusStream = receiver.subscribe('all', {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1000
            }
        });

        const file = `recording-${Date.now()}`;
        const pcm = `./${file}.pcm`;

        const decoder = new prism.opus.Decoder({
            rate: 48000,
            channels: 2,
            frameSize: 960
        });

        const writeStream = fs.createWriteStream(pcm);

        opusStream.pipe(decoder).pipe(writeStream);

        console.log("🎤 Grabando VC...");
    } catch (err) {
        console.log("⚠️ Grabación desactivada (opus no disponible)");
    }
}

// 💬 COMANDOS
client.on('messageCreate', async (msg) => {
    if (!msg.content.startsWith('-') || msg.author.bot) return;

    const args = msg.content.slice(1).split(' ');
    const cmd = args.shift().toLowerCase();

    console.log("CMD:", cmd);

    if (cmd === 'help') {
        return msg.reply(`
🎵 Comandos:
-play <nombre/url>
-pause
-resume
-skip
-mov
-help
    `);
    }

    if (cmd === 'play') {
        if (!scReady) return msg.reply("⏳ Espera...");

        const query = args.join(' ');
        const vc = msg.member.voice.channel;

        if (!vc) return msg.reply('❌ Entra a un VC');

        currentChannel = msg.channel;

        if (!connection) {
            connection = joinVoiceChannel({
                channelId: vc.id,
                guildId: vc.guild.id,
                adapterCreator: vc.guild.voiceAdapterCreator,
                selfDeaf: false
            });

            startRecording(connection);
        }

        const result = await play.search(query, {
            limit: 1,
            source: { soundcloud: "tracks" }
        });

        if (!result.length) return msg.reply("❌ No encontrado");

        queue.push({
            title: result[0].title,
            url: result[0].url
        });

        msg.reply('✅ Añadido');

        if (queue.length === 1) playMusic(msg.channel);
    }

    if (cmd === 'pause') player.pause();
    if (cmd === 'resume') player.unpause();
    if (cmd === 'skip') player.stop();

    if (cmd === 'mov') {
        const vc = msg.member.voice.channel;
        if (!vc) return;

        connection.destroy();

        connection = joinVoiceChannel({
            channelId: vc.id,
            guildId: vc.guild.id,
            adapterCreator: vc.guild.voiceAdapterCreator,
            selfDeaf: false
        });

        startRecording(connection);
    }
});

// 🔘 BOTONES
client.on('interactionCreate', async (i) => {
    if (!i.isButton()) return;

    if (i.customId === 'pause') player.pause();
    if (i.customId === 'resume') player.unpause();
    if (i.customId === 'skip') player.stop();

    i.reply({ content: 'OK', ephemeral: true });
});

// 🔌 AUTO DESCONECTAR
setInterval(() => {
    if (!connection) return;

    const channel = client.channels.cache.get(connection.joinConfig.channelId);
    if (!channel) return;

    const humans = channel.members.filter(m => !m.user.bot);

    if (humans.size === 0) {
        if (!timeout) {
            timeout = setTimeout(() => {
                connection.destroy();
                connection = null;
                queue = [];
            }, 10000);
        }
    } else {
        clearTimeout(timeout);
        timeout = null;
    }
}, 5000);

client.login(process.env.TOKEN);