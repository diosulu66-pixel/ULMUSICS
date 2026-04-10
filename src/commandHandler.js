const { playCommand } = require('./musicPlayer');
const { pauseCommand, skipCommand, stopCommand, listCommand, moveCommand } = require('./musicPlayer');
const { helpCommand } = require('./helpCommand');

const COMMANDS = {
  play:  { fn: playCommand,   usage: '-play <nombre de canción>' },
  pause: { fn: pauseCommand,  usage: '-pause' },
  resume:{ fn: async (c,m) => { const { resumeCommand } = require('./musicPlayer'); await resumeCommand(c,m); }, usage: '-resume' },
  skip:  { fn: skipCommand,   usage: '-skip' },
  stop:  { fn: stopCommand,   usage: '-stop' },
  list:  { fn: listCommand,   usage: '-list' },
  queue: { fn: listCommand,   usage: '-queue' },
  mov:   { fn: moveCommand,   usage: '-mov <nombre o ID del canal>' },
  move:  { fn: moveCommand,   usage: '-move <nombre o ID del canal>' },
  help:  { fn: helpCommand,   usage: '-help' },
};

async function handleCommand(client, message) {
  const args = message.content.slice(1).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  const command = COMMANDS[commandName];
  if (!command) return;

  try {
    await command.fn(client, message, args);
  } catch (err) {
    console.error(`Error in command ${commandName}:`, err);
    await message.reply(`❌ Error ejecutando el comando: ${err.message}`);
  }
}

module.exports = { handleCommand };
