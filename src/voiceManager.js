const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} = require('@discordjs/voice');
const fs   = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// ─────────────────────────────────────────────
//  Recordings directory - RAILWAY COMPATIBLE
// ─────────────────────────────────────────────

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/mnt/recordings';
console.log(`📁 Recording directory: ${RECORDINGS_DIR}`);
try {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    console.log(`✅ Created recordings directory: ${RECORDINGS_DIR}`);
  }
} catch (err) {
  console.error(`❌ Failed to create recordings directory: ${err.message}`);
}

// ─────────────────────────────────────────────
//  Auto-join logic
// ─────────────────────────────────────────────

async function handleVoiceStateUpdate(client, oldState, newState) {
  if (newState.member?.user?.bot) return;

  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) return;

  // Usuario se une a canal de voz
  if (!oldState.channelId && newState.channelId) {
    await handleUserJoin(client, newState);
  }

  // Usuario se va del canal de voz
  if (oldState.channelId && !newState.channelId) {
    await handleUserLeave(client, oldState);
  }

  // Usuario se mueve de canal
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    await handleUserLeave(client, oldState);
  }
}

async function handleUserJoin(client, voiceState) {
  const guildId  = voiceState.guild.id;
  const channel  = voiceState.channel;

  if (!channel) return;

  const existing = client.connections.get(guildId);
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
    console.log(`⚠️ Ya conectado en ${channel.guild.name}, saltando auto-join`);
    return;
  }

  if (existing) {
    try { existing.destroy(); } catch {}
    client.connections.delete(guildId);
    client.players.delete(guildId);
  }

  try {
    const connection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        guildId,
      adapterCreator: voiceState.guild.voiceAdapterCreator,
      selfDeaf:       false,
      selfMute:       false,
    });

    let ready = false;
    let attempts = 0;
    const maxAttempts = 2;

    while (!ready && attempts < maxAttempts) {
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        ready = true;
        console.log(`✅ Auto-join exitoso: ${channel.name}`);
      } catch (err) {
        attempts++;
        if (attempts < maxAttempts) {
          console.log(`⏱️ Intento ${attempts} falló, reintentando en 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          throw new Error(`No se pudo conectar después de ${maxAttempts} intentos`);
        }
      }
    }

    if (!ready) {
      connection.destroy();
      return;
    }

    client.connections.set(guildId, connection);
    startRecording(client, connection, guildId, channel.name);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        console.log('⚠️ No se pudo recuperar conexión, limpiando...');
        stopRecording(client, guildId);
        connection.destroy();
        client.connections.delete(guildId);
        client.players.delete(guildId);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log('🔴 Conexión de voz destruida');
      stopRecording(client, guildId);
      client.connections.delete(guildId);
      client.players.delete(guildId);
      client.queues.delete(guildId);
      if (client.currentTrack) delete client.currentTrack[guildId];
    });

  } catch (err) {
    console.error('❌ Error en auto-join:', err.message);
    const conn = client.connections.get(guildId);
    if (conn) {
      try { conn.destroy(); } catch {}
      client.connections.delete(guildId);
    }
  }
}

async function handleUserLeave(client, voiceState) {
  const guildId    = voiceState.guild.id;
  const connection = client.connections.get(guildId);

  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;

  // FIX: obtener el canal actual del bot directamente, sin depender del cache
  const botMember = voiceState.guild.members.me;
  const botChannel = botMember?.voice?.channel;

  if (!botChannel) return;

  // Solo actuar si el usuario que salió estaba en el mismo canal que el bot
  if (voiceState.channelId !== botChannel.id) return;

  const humans = botChannel.members.filter((m) => !m.user.bot);

  if (humans.size === 0) {
    console.log(`⏳ Canal vacío, desconectando en 10s...`);

    if (!client.leaveTimeouts) client.leaveTimeouts = {};
    const timeoutKey = `disconnect_${guildId}`;

    if (client.leaveTimeouts[timeoutKey]) {
      clearTimeout(client.leaveTimeouts[timeoutKey]);
    }

    client.leaveTimeouts[timeoutKey] = setTimeout(async () => {
      const conn = client.connections.get(guildId);
      if (!conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
        delete client.leaveTimeouts[timeoutKey];
        return;
      }

      // FIX: re-verificar con el canal actualizado del bot en este momento
      const currentBotMember = voiceState.guild.members.me;
      const currentChannel   = currentBotMember?.voice?.channel;

      if (!currentChannel) {
        delete client.leaveTimeouts[timeoutKey];
        return;
      }

      const currentHumans = currentChannel.members.filter((m) => !m.user.bot);
      if (currentHumans.size > 0) {
        console.log(`⚠️ Humanos presentes, cancelando desconexión`);
        delete client.leaveTimeouts[timeoutKey];
        return;
      }

      console.log(`👋 Desconectando de ${currentChannel.name} (canal vacío)`);
      stopRecording(client, guildId);
      conn.destroy();
      client.connections.delete(guildId);
      client.players.delete(guildId);
      client.queues.delete(guildId);
      if (client.currentTrack) delete client.currentTrack[guildId];
      client.embedMessages.delete(guildId);
      delete client.leaveTimeouts[timeoutKey];
    }, 10_000);
  }
}

// ─────────────────────────────────────────────
//  Recording — saves each speaker as MP3
// ─────────────────────────────────────────────

function startRecording(client, connection, guildId, channelName) {
  if (client.recorders.has(guildId)) {
    console.log(`⚠️ Ya está registrando en guild ${guildId}`);
    return;
  }

  const dateStr    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionDir = path.join(RECORDINGS_DIR, `${dateStr}_${guildId}`);

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch (err) {
    console.error(`❌ Error creando directorio de grabación: ${err.message}`);
    return;
  }

  const receiver    = connection.receiver;
  const activeUsers = new Map();

  receiver.speaking.on('start', (userId) => {
    if (activeUsers.has(userId)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pcmPath   = path.join(sessionDir, `${userId}_${timestamp}.pcm`);
    const mp3Path   = path.join(sessionDir, `${userId}_${timestamp}.mp3`);

    let writeStream;
    try {
      writeStream = fs.createWriteStream(pcmPath);
    } catch (err) {
      console.error(`❌ Error creando write stream: ${err.message}`);
      return;
    }

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    });

    opusStream.on('data', (chunk) => {
      try { writeStream.write(chunk); } catch (err) {
        console.error(`Error escribiendo audio: ${err.message}`);
      }
    });

    opusStream.on('end', () => {
      writeStream.end();
      activeUsers.delete(userId);
      console.log(`🎙️ Grabación completada: ${path.basename(pcmPath)}`);
      convertToMp3(pcmPath, mp3Path, userId);
    });

    opusStream.on('error', (err) => {
      console.error(`Recording error para ${userId}:`, err.message);
      writeStream.end();
      activeUsers.delete(userId);
    });

    activeUsers.set(userId, { opusStream, pcmPath, mp3Path });
    console.log(`🎙️ Grabando: ${userId} → ${path.basename(pcmPath)}`);
  });

  const meta = {
    guildId,
    channelName,
    startedAt:  new Date().toISOString(),
    sessionDir,
    format:     'MP3 (Opus → PCM → MP3 via ffmpeg)',
    note:       'Cada archivo = un segmento de voz continuo por usuario',
  };

  try {
    fs.writeFileSync(path.join(sessionDir, 'session_info.json'), JSON.stringify(meta, null, 2));
  } catch (err) {
    console.error(`Error escribiendo metadata: ${err.message}`);
  }

  client.recorders.set(guildId, { sessionDir, activeUsers, channelName, startedAt: new Date() });
  console.log(`📁 Sesión de grabación iniciada: ${sessionDir}`);
}

function stopRecording(client, guildId) {
  const info = client.recorders.get(guildId);
  if (!info) return;

  for (const [, data] of info.activeUsers) {
    try { data.opusStream?.destroy(); } catch {}
  }
  info.activeUsers.clear();

  try {
    const metaPath = path.join(info.sessionDir, 'session_info.json');
    const meta     = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.endedAt   = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch {}

  client.recorders.delete(guildId);
  console.log(`⏹️ Sesión de grabación finalizada: ${info.sessionDir}`);
}

// ─────────────────────────────────────────────
//  Convert opus PCM → MP3
// ─────────────────────────────────────────────

function convertToMp3(pcmPath, mp3Path, userId) {
  if (!fs.existsSync(pcmPath)) {
    console.error(`❌ Archivo PCM no existe: ${pcmPath}`);
    return;
  }

  ffmpeg(pcmPath)
    .inputFormat('s16le')
    .inputOptions(['-ar 48000', '-ac 2'])
    .audioCodec('libmp3lame')
    .audioBitrate('128k')
    .output(mp3Path)
    .on('start', (cmd) => console.log(`⚙️ Convirtiendo: ${cmd}`))
    .on('end', () => {
      console.log(`✅ MP3 guardado: ${path.basename(mp3Path)}`);
      try { fs.unlinkSync(pcmPath); } catch (err) {
        console.log(`⚠️ No se pudo borrar PCM: ${err.message}`);
      }
    })
    .on('error', (err) => {
      console.error(`❌ Error ffmpeg para ${userId}:`, err.message);
    })
    .run();
}

module.exports = { handleVoiceStateUpdate, startRecording, stopRecording };
