require('dotenv').config();
const { REST, Routes } = require('discord.js');
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const guildId = process.env.GUILD_ID;
    if (!guildId) throw new Error('Set GUILD_ID in .env for testing');
    const cmds = await rest.get(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId));
    console.log('Registered commands:', cmds.map(c => c.name));
  } catch (e) {
    console.error('List commands error:', e.message);
  }
})();