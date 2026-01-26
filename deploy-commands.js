require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('pomo')
    .setDescription('Prisoner work session controls')
    .addSubcommand(sc =>
      sc.setName('start')
        .setDescription('Start today’s session (loops until stopped)')
        .addStringOption(o =>
          o.setName('mode')
            .setDescription('session prefix')
            .setRequired(true)
            .addChoices(
              { name: 'self', value: 'self' },
              { name: 'irl', value: 'irl' }
            )
        )
        .addIntegerOption(o => o.setName('slice').setDescription('slice minutes (default 32)').setMinValue(1))
        .addIntegerOption(o => o.setName('short').setDescription('short break minutes (default 5)').setMinValue(0))
        .addIntegerOption(o => o.setName('long').setDescription('long break minutes (default 14)').setMinValue(0))
        .addIntegerOption(o => o.setName('slices').setDescription('slices per pomodoro (default 3)').setMinValue(1).setMaxValue(12))
    )
    .addSubcommand(sc => sc.setName('pause').setDescription('Pause current session (host or admin)'))
    .addSubcommand(sc => sc.setName('resume').setDescription('Resume paused session (host or admin)'))
    .addSubcommand(sc => sc.setName('stop').setDescription('Stop current session (host or admin)'))
    .addSubcommand(sc => sc.setName('status').setDescription('Show current session status'))
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Registered guild commands.');
})();
