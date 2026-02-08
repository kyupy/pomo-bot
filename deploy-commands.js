require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  throw new Error('Missing env: DISCORD_TOKEN / CLIENT_ID / GUILD_ID');
}

const pomo = new SlashCommandBuilder()
  .setName('pomo')
  .setDescription('Pomodoro bot');

pomo.addSubcommand(sc =>
  sc.setName('start').setDescription('Start a new session')
    .addStringOption(o =>
      o.setName('mode')
        .setDescription('self or irl (default: self)')
        .addChoices(
          { name: 'self', value: 'self' },
          { name: 'irl', value: 'irl' },
        )
        .setRequired(false)
    )
    .addIntegerOption(o => o.setName('slice').setDescription('focus minutes (default: 32)').setRequired(false))
    .addIntegerOption(o => o.setName('short').setDescription('short break minutes (default: 5)').setRequired(false))
    .addIntegerOption(o => o.setName('long').setDescription('long break minutes (default: 14)').setRequired(false))
    .addIntegerOption(o => o.setName('slices').setDescription('slices per pomodoro (default: 3)').setRequired(false))
);


pomo.addSubcommand(sc => sc.setName('pause').setDescription('Pause (host/admin)'));
pomo.addSubcommand(sc => sc.setName('resume').setDescription('Resume (host/admin)'));
pomo.addSubcommand(sc => sc.setName('stop').setDescription('Stop (host/admin)'));
pomo.addSubcommand(sc => sc.setName('status').setDescription('Show status'));

pomo.addSubcommand(sc => sc.setName('join').setDescription('Join (time accounting)'));
pomo.addSubcommand(sc => sc.setName('leave').setDescription('Leave (time accounting)'));

pomo.addSubcommand(sc =>
  sc.setName('edit-goal').setDescription('Edit goal for a slice')
    .addIntegerOption(o => o.setName('slice').setDescription('sliceSeq').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('goal text').setRequired(true))
);

pomo.addSubcommand(sc =>
  sc.setName('edit-result').setDescription('Edit result for a slice')
    .addIntegerOption(o => o.setName('slice').setDescription('sliceSeq').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('result text').setRequired(true))
);

const commands = [pomo.toJSON()];

(async () => {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('✅ Deployed guild commands');
})();
