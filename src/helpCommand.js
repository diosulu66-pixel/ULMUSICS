const { EmbedBuilder } = require('discord.js');

async function helpCommand(client, message) {
  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle('🎵  Music Bot — Comandos')
    .setDescription('Prefijo: **`-`**  |  Ejemplo: `-play despacito`')
    .addFields(
  {
    name: '🎵 Música',
    value: [
      '`-play <canción>` — Busca en **Spotify** y reproduce',
      '`-play <link Spotify>` — Reproduce un track o playlist de Spotify',
      '`-play <link YouTube>` — Reproduce una URL de YouTube directamente',
      '`-pause` — Pausa la reproducción',
      '`-resume` — Reanuda la reproducción',
      '`-skip` — Salta a la siguiente canción',
      '`-stop` — Detiene la música y desconecta el bot',
      '`-list` / `-queue` — Muestra la cola de reproducción',
    ].join('\n'),
  },
  {
    name: '🔊 Voz',
    value: [
      '`-mov <nombre o ID>` — Mueve el bot a otro canal de voz',
      '`-move <nombre o ID>` — (alias de -mov)',
    ].join('\n'),
  },
  {
    name: '🎛️ Panel de Control (Embed)',
    value: [
      'Cuando el bot reproduce música, aparece un **embed interactivo** con botones:',
      '⏸️ **Pausar/Reanudar** — Pausa o reanuda la canción',
      '⏭️ **Siguiente** — Salta a la siguiente canción',
      '⏹️ **Detener** — Detiene todo y desconecta',
      '📋 **Ver Cola** — Muestra las canciones en cola',
      '🔀 **Mezclar** — Mezcla aleatoriamente la cola',
    ].join('\n'),
  },
  {
    name: '🎙️ Grabación Automática',
    value: [
      'El bot graba automáticamente lo que dicen los usuarios en el canal de voz.',
      'Las grabaciones se guardan en la carpeta `recordings/` del servidor.',
      'Cada sesión tiene su propia carpeta con archivos `.mp3` por usuario.',
    ].join('\n'),
  },
  {
    name: '🤖 Auto-unión',
    value: [
      'El bot se une automáticamente al canal de voz cuando un usuario entra.',
      'Si el canal queda vacío por 10 segundos, el bot se desconecta.',
      'Usa `-mov` para moverlo a otro canal manualmente.',
    ].join('\n'),
  }
)
    .setFooter({ text: 'Music Bot • Hecho con discord.js + @discordjs/voice' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

module.exports = { helpCommand };
