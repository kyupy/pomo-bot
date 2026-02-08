require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { registerHandlers } = require('./src/interactions');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

registerHandlers(client);

client.login(process.env.DISCORD_TOKEN);
