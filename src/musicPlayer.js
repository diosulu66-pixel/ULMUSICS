const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { searchTrack, resolveTrackUrl, getAudioStream } = require('./spotifySearch');


// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function getQueue(client, guildId) {
  if (!client.queues.has(guildId)) client.queues.set(guildId, []);
  return client.queues.get(guildId);
}

function formatDuration(seconds) {
  if (!seconds) return '?:??';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────
//  Player embed + buttons
// ─────────────────────────────────────────────

function buildPlayerEmbed(client, guildId, track, isPaused = false) {
  const queue = getQueue(client, guildId);

  const embed = new EmbedBuilder()
    .setColor(isPaused ? 0xf0a500 : 0x1db954)
    .setTitle(isPaused ? '⏸️  Pausado' : '🎵  Reproduciendo ahora')
    .setDescription(`**[${track.title}](${track.url})**`)
    .setThumbnail(track.thumbnail || null)
    .addFields(
      { name: '⏱ Duración',    value: formatDuration(track.duration), inline: true },
      { name: '👤 Pedido por',  value: track.requestedBy,              inline: true },
      { name: '📋 En cola',     value: `${queue.length} canción(es)`,  inline: true }
    )
    .setFooter({ text: track.album ? `💿 ${track.album}` : 'Usa los botones para controlar' })
    .setTimestamp();

  if (track.spotifyUrl) {
    embed.addFields({ name: '🎧 Spotify', value: `[Ver en Spotify](${track.spotifyUrl})`, inline: true });
  }

  if (queue.length > 0) {
    const nextItems = queue.slice(0, 5).map((t, i) => `**${i + 1}.** ${t.title}`).join('\n');
    embed.addFields({ name: '🔜 Próximas', value: nextItems });
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_pause_resume')
      .setLabel(isPaused ? 'Reanudar' : 'Pausar')
      .setEmoji(isPaused ? '▶️' : '⏸️')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setLabel('Siguiente')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('music_stop')
      .setLabel('Detener')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_list')
      .setLabel('Ver Cola')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_shuffle')
      .setLabel('Mezclar')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ─────────────────────────────────────────────
//  Play next track in queue
// ─────────────────────────────────────────────

async function playNext(client, guildId, textChannel) {
  const queue = getQueue(client, guildId);
  const connection = client.connections.get(guildId);

  if (!connection || queue.length === 0) {
    const embedMsg = client.embedMessages.get(guildId);
    if (embedMsg) {
      const embed = new EmbedBuilder()
        .setColor(0x36393f)
        .setTitle('📭  Cola vacía')
        .setDescription('Añade canciones con `-play <nombre, artista o link de Spotify>`')
        .setTimestamp();
      await embedMsg.edit({ embeds: [embed], components: [] }).catch(() => {});
    }
    if (!client.currentTrack) client.currentTrack = {};
    delete client.currentTrack[guildId];
    return;
  }

  let track = queue.shift();

  // Resolve YouTube URL for lazy Spotify playlist tracks
  try {
    track = await resolveTrackUrl(track);
  } catch (err) {
    console.error('Failed to resolve track URL:', err);
    await textChannel.send(`❌ No pude encontrar audio para **${track.title}**. Saltando...`);
    return playNext(client, guildId, textChannel);
  }

  if (!client.currentTrack) client.currentTrack = {};
  client.currentTrack[guildId] = track;

  try {
    const stream = await getAudioStream(track.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true,
    });
    resource.volume?.setVolume(0.5);

    let player = client.players.get(guildId);
    if (!player) {
      player = createAudioPlayer();
      client.players.set(guildId, player);
      connection.subscribe(player);

      player.on(AudioPlayerStatus.Idle, () => playNext(client, guildId, textChannel));
      player.on('error', (err) => {
        console.error('Audio player error:', err.message);
        playNext(client, guildId, textChannel);
      });
    }

    player.play(resource);

    const embedContent = buildPlayerEmbed(client, guildId, track, false);
    const existingEmbed = client.embedMessages.get(guildId);
    if (existingEmbed) {
      await existingEmbed.edit(embedContent).catch(async () => {
        const newMsg = await textChannel.send(embedContent);
        client.embedMessages.set(guildId, newMsg);
      });
    } else {
      const newMsg = await textChannel.send(embedContent);
      client.embedMessages.set(guildId, newMsg);
    }

  } catch (err) {
    console.error('Error playing track:', err);
    await textChannel.send(`❌ Error reproduciendo **${track.title}**. Saltando...`);
    playNext(client, guildId, textChannel);
  }
}

// ─────────────────────────────────────────────
//  Ensure voice connection
// ─────────────────────────────────────────────

async function ensureConnection(client, message) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply('❌ Debes estar en un canal de voz primero.');
    return null;
  }

  let connection = client.connections.get(message.guildId);
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch {
      connection.destroy();
      await message.reply('❌ No pude conectarme al canal de voz.');
      return null;
    }

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        connection.destroy();
        client.connections.delete(message.guildId);
        client.players.delete(message.guildId);
      }
    });

    client.connections.set(message.guildId, connection);
  }

  return connection;
}

// ─────────────────────────────────────────────
//  Commands
// ─────────────────────────────────────────────

async function playCommand(client, message, args) {
  if (!args.length) return message.reply('❌ Uso: `-play <canción, artista o link de Spotify/YouTube>`');

  const query = args.join(' ');
  const loadingMsg = await message.reply(`🔍 Buscando **${query}**...`);

  let result;
  try {
    result = await searchTrack(query);
  } catch (err) {
    await loadingMsg.delete().catch(() => {});
    return message.reply(`❌ No encontré: **${query}**\n> ${err.message}`);
  }

  const connection = await ensureConnection(client, message);
  if (!connection) { await loadingMsg.delete().catch(() => {}); return; }
  await loadingMsg.delete().catch(() => {});

  // Playlist
  if (result.isPlaylist) {
    const queue = getQueue(client, message.guildId);
    result.tracks.forEach((t) => queue.push({ ...t, requestedBy: message.author.username }));

    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle('📂 Playlist añadida')
      .setDescription(`**${result.playlistName}**`)
      .addFields({ name: '🎵 Canciones', value: `${result.tracks.length} canciones añadidas a la cola` })
      .setTimestamp();
    await message.channel.send({ embeds: [embed] });

    const player = client.players.get(message.guildId);
    const isActive = player && [AudioPlayerStatus.Playing, AudioPlayerStatus.Paused].includes(player.state.status);
    if (!isActive) await playNext(client, message.guildId, message.channel);
    return;
  }

  // Single track
  const track = { ...result, requestedBy: message.author.username };
  const queue = getQueue(client, message.guildId);
  const player = client.players.get(message.guildId);
  const isActive = player && [AudioPlayerStatus.Playing, AudioPlayerStatus.Paused].includes(player.state.status);

  if (isActive) {
    queue.push(track);
    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle('✅ Añadido a la cola')
      .setDescription(`**${track.title}**`)
      .setThumbnail(track.thumbnail)
      .addFields(
        { name: '⏱ Duración', value: formatDuration(track.duration), inline: true },
        { name: '📍 Posición', value: `#${queue.length}`, inline: true },
        ...(track.album ? [{ name: '💿 Álbum', value: track.album, inline: true }] : [])
      )
      .setTimestamp();
    await message.channel.send({ embeds: [embed] });
  } else {
    queue.unshift(track);
    await playNext(client, message.guildId, message.channel);
  }
}

async function pauseCommand(client, message) {
  const player = client.players.get(message.guildId);
  if (!player || player.state.status !== AudioPlayerStatus.Playing)
    return message.reply('❌ No hay música reproduciéndose.');
  player.pause();
  const track = client.currentTrack?.[message.guildId];
  if (track) {
    const embedMsg = client.embedMessages.get(message.guildId);
    if (embedMsg) await embedMsg.edit(buildPlayerEmbed(client, message.guildId, track, true)).catch(() => {});
  }
  await message.react('⏸️');
}

async function resumeCommand(client, message) {
  const player = client.players.get(message.guildId);
  if (!player || player.state.status !== AudioPlayerStatus.Paused)
    return message.reply('❌ La música no está pausada.');
  player.unpause();
  const track = client.currentTrack?.[message.guildId];
  if (track) {
    const embedMsg = client.embedMessages.get(message.guildId);
    if (embedMsg) await embedMsg.edit(buildPlayerEmbed(client, message.guildId, track, false)).catch(() => {});
  }
  await message.react('▶️');
}

async function skipCommand(client, message) {
  const player = client.players.get(message.guildId);
  if (!player || ![AudioPlayerStatus.Playing, AudioPlayerStatus.Paused].includes(player.state.status))
    return message.reply('❌ No hay nada que saltar.');
  player.stop();
  await message.react('⏭️');
}

async function stopCommand(client, message) {
  const queue = getQueue(client, message.guildId);
  queue.length = 0;

  const player = client.players.get(message.guildId);
  if (player) player.stop();

  const connection = client.connections.get(message.guildId);
  if (connection) { connection.destroy(); client.connections.delete(message.guildId); }

  client.players.delete(message.guildId);
  if (client.currentTrack) delete client.currentTrack[message.guildId];

  const embedMsg = client.embedMessages.get(message.guildId);
  if (embedMsg) {
    const embed = new EmbedBuilder()
      .setColor(0xff4444).setTitle('⏹️  Reproducción detenida').setDescription('El bot se desconectó.').setTimestamp();
    await embedMsg.edit({ embeds: [embed], components: [] }).catch(() => {});
    client.embedMessages.delete(message.guildId);
  }
  await message.react('⏹️');
}

async function listCommand(client, message) {
  const queue = getQueue(client, message.guildId);
  const current = client.currentTrack?.[message.guildId];
  const embed = new EmbedBuilder().setColor(0x1db954).setTitle('📋 Cola de reproducción').setTimestamp();

  if (current) embed.addFields({ name: '🎵 Reproduciendo ahora', value: `**${current.title}** — \`${formatDuration(current.duration)}\`` });
  if (queue.length === 0) {
    embed.setDescription(current ? 'No hay canciones en cola.' : '❌ La cola está vacía.');
  } else {
    embed.setDescription(queue.slice(0, 15).map((t, i) => `**${i + 1}.** ${t.title} — \`${formatDuration(t.duration)}\` • **${t.requestedBy}**`).join('\n'));
    if (queue.length > 15) embed.setFooter({ text: `...y ${queue.length - 15} canciones más` });
    embed.addFields({ name: '📊 Total', value: `${queue.length} canción(es)`, inline: true });
  }
  await message.reply({ embeds: [embed] });
}

async function moveCommand(client, message, args) {
  if (!args.length) return message.reply('❌ Uso: `-mov <nombre o ID del canal>`');
  const query = args.join(' ').toLowerCase();
  const targetChannel = message.guild.channels.cache.find(
    (c) => c.isVoiceBased() && (c.id === query || c.name.toLowerCase().includes(query))
  );
  if (!targetChannel) return message.reply(`❌ No encontré el canal: **${args.join(' ')}**`);
  const connection = client.connections.get(message.guildId);
  if (!connection) return message.reply('❌ El bot no está en ningún canal de voz.');

  const newConnection = joinVoiceChannel({
    channelId: targetChannel.id,
    guildId: message.guildId,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false,
  });

  try {
    await entersState(newConnection, VoiceConnectionStatus.Ready, 10_000);
    client.connections.set(message.guildId, newConnection);
    const player = client.players.get(message.guildId);
    if (player) newConnection.subscribe(player);
    await message.reply(`✅ Movido a: **${targetChannel.name}**`);
  } catch {
    newConnection.destroy();
    await message.reply('❌ No pude moverme a ese canal.');
  }
}

// ─────────────────────────────────────────────
//  Button interactions
// ─────────────────────────────────────────────

async function handleButtonInteraction(client, interaction) {
  const guildId = interaction.guildId;
  const fakeMsg = {
    guildId,
    guild: interaction.guild,
    member: interaction.member,
    channel: interaction.channel,
    author: interaction.user,
    react: () => {},
    reply: (c) => interaction.followUp({ ...(typeof c === 'string' ? { content: c } : c), ephemeral: true }).catch(() => {}),
  };

  await interaction.deferUpdate().catch(() => {});

  switch (interaction.customId) {
    case 'music_pause_resume': {
      const player = client.players.get(guildId);
      if (!player) return;
      if (player.state.status === AudioPlayerStatus.Playing) await pauseCommand(client, fakeMsg);
      else if (player.state.status === AudioPlayerStatus.Paused) await resumeCommand(client, fakeMsg);
      break;
    }
    case 'music_skip':  await skipCommand(client, fakeMsg); break;
    case 'music_stop':  await stopCommand(client, fakeMsg); break;
    case 'music_list': {
      const queue = getQueue(client, guildId);
      const current = client.currentTrack?.[guildId];
      const embed = new EmbedBuilder().setColor(0x1db954).setTitle('📋 Cola').setTimestamp();
      if (current) embed.addFields({ name: '🎵 Ahora', value: `${current.title} (${formatDuration(current.duration)})` });
      embed.setDescription(
        queue.length === 0 ? 'Cola vacía.'
          : queue.slice(0, 10).map((t, i) => `**${i + 1}.** ${t.title} — \`${formatDuration(t.duration)}\``).join('\n')
      );
      await interaction.followUp({ embeds: [embed], ephemeral: true }).catch(() => {});
      break;
    }
    case 'music_shuffle': {
      const queue = getQueue(client, guildId);
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      await interaction.followUp({ content: '🔀 Cola mezclada!', ephemeral: true }).catch(() => {});
      break;
    }
  }
}

module.exports = {
  playCommand, pauseCommand, resumeCommand, skipCommand,
  stopCommand, listCommand, moveCommand,
  handleButtonInteraction, playNext, ensureConnection, buildPlayerEmbed,
};
