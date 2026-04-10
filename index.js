process.env.OPUS_SCRIPT = "1";

require('dotenv').config();
const fs = require('fs');
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

// ====== CLIENT ======
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ====== VARIABLES ======
let queue = [];
let player = createAudioPlayer();
let connection = null;
let currentChannel = null;
let autoplay = true;

// ====== FORMAT TIME ======
function formatTime(ms) {
    if (!ms) return "??:??";
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ====== SOUNDCLOUD ======
(async () => {
    const client_id = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id } });
    console.log("✅ SoundCloud listo");
})();

// ====== READY ======
client.once('clientReady', () => {
    console.log(`✅ Bot listo como ${client.user.tag}`);
});

// ====== PLAY FUNCTION ======
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
            .setColor('#00ffcc')
            .setTitle('🎵 Reproduciendo')
            .setDescription(`**${song.title || "🎶 Desconocido"}**`)
            .addFields(
                { name: "⏱️ Duración", value: song.duration || "??:??", inline: true },
                { name: "👤 Pedido por", value: song.user || "Desconocido", inline: true }
            )
            .setFooter({ text: `En cola: ${queue.length - 1}` });

        if (song.thumbnail) embed.setThumbnail(song.thumbnail);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pause').setLabel('⏸️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('resume').setLabel('▶️').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('skip').setLabel('⏭️').setStyle(ButtonStyle.Danger)
        );

        channel.send({ embeds: [embed], components: [row] });

    } catch (err) {
        console.log("❌ Error:", err);
        queue.shift();
        playMusic(channel);
    }
}

// ====== AUTO NEXT ======
player.on(AudioPlayerStatus.Idle, async () => {
    queue.shift();

    if (!queue.length && autoplay) {
        try {
            const random = await play.search("lofi", { limit: 1 });
            const t = random[0];

            queue.push({
                title: t.title || "Autoplay",
                url: t.url,
                duration: formatTime(t.durationInSec * 1000)
            });
        } catch { }
    }

    playMusic(currentChannel);
});

// ====== RECORD SAFE ======
function startRecording(connection) {
    try {
        const receiver = connection.receiver;

        const opusStream = receiver.subscribe('all', {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1000
            }
        });

        const decoder = new prism.opus.Decoder({
            rate: 48000,
            channels: 2,
            frameSize: 960
        });

        opusStream.pipe(decoder);

        console.log("🎤 Grabando VC...");
    } catch {
        console.log("⚠️ Grabación desactivada");
    }
}

// ====== COMMANDS ======
client.on('messageCreate', async (msg) => {
    if (!msg.content.startsWith('-') || msg.author.bot) return;

    const args = msg.content.slice(1).split(' ');
    const cmd = args.shift().toLowerCase();

    if (cmd === 'help') {
        return msg.reply(`
🎵 **Comandos**
-play <nombre/url>
-pause
-resume
-skip
-queue
-autoplay
-mov
    `);
    }

    if (cmd === 'play') {
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

        const track = result[0];

        queue.push({
            title: track.title || track.name || "🎶 Desconocido",
            url: track.url,
            duration: formatTime(track.durationInSec * 1000),
            thumbnail: track.thumbnail?.url,
            user: msg.author.username
        });

        msg.reply('✅ Añadido');

        if (queue.length === 1) playMusic(msg.channel);
    }

    if (cmd === 'queue') {
        if (!queue.length) return msg.reply("📭 Vacía");

        const list = queue.map((s, i) =>
            `${i === 0 ? "▶️" : `${i}.`} ${s.title}`
        ).slice(0, 10).join('\n');

        msg.reply(`📃 **Cola**\n${list}`);
    }

    if (cmd === 'pause') player.pause();
    if (cmd === 'resume') player.unpause();
    if (cmd === 'skip') player.stop();

    if (cmd === 'autoplay') {
        autoplay = !autoplay;
        msg.reply(`🔁 Autoplay: ${autoplay ? "ON" : "OFF"}`);
    }

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

// ====== BUTTONS ======
client.on('interactionCreate', async (i) => {
    if (!i.isButton()) return;

    if (i.customId === 'pause') player.pause();
    if (i.customId === 'resume') player.unpause();
    if (i.customId === 'skip') player.stop();

    i.reply({ content: 'OK', ephemeral: true });
});

// ====== AUTO DISCONNECT ======
setInterval(() => {
    if (!connection) return;

    const channel = client.channels.cache.get(connection.joinConfig.channelId);
    if (!channel) return;

    const humans = channel.members.filter(m => !m.user.bot);

    if (humans.size === 0) {
        setTimeout(() => {
            if (connection) {
                connection.destroy();
                connection = null;
                queue = [];
            }
        }, 10000);
    }
}, 5000);

client.login(process.env.TOKEN);