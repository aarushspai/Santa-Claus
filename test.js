const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.once('ready', () => console.log('READY:', client.user.tag));
client.login(process.env.DISCORD_TOKEN).catch(e => console.error('LOGIN ERR:', e.message));