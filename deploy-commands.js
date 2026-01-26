require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('pomo')
    .setDescription('Pomodoro session controls')
    .addSubcommand(sc =>
      sc.setName('start')
        .setDescription('Start today’s (single) session')
        .addStringOption(o =>
          o.setName('mode')
            .setDescription('session mode prefix')
            .setRequired(true)
            .addChoices(
              { name: 'self', value: 'self' },
              { name: 'irl', value: 'irl' }
            )
        )
        .addIntegerOption(o =>
          o.setName('focus')
            .setDescription('focus minutes (default 25)')
            .setMinValue(1)
        )
        .addIntegerOption(o =>
          o.setName('break')
            .setDescription('break minutes (default 5)')
            .setMinValue(1)
        )
        .addIntegerOption(o =>
          o.setName('rounds')
            .setDescription('rounds (default 4)')
            .setMinValue(1)
            .setMaxValue(12)
        )
    )
    .addSubcommand(sc =>
      sc.setName('stop')
        .setDescription('Stop current session (admin only)')
    )
    .addSubcommand(sc =>
      sc.setName('status')
        .setDescription('Show current session status')
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.GUILD_ID;

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('✅ Registered guild commands.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
