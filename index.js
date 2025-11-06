/**
 * Christmas Gift Bot — Final index.js
 * - Enforces single-claim-per-user-per-drop: once a user claims any box in a drop, they cannot claim another box from the same drop.
 * - All other features retained from previous version.
 *
 * .env: DISCORD_TOKEN, CLIENT_ID, OWNER_ID
 * Optional: MOD_ROLE_ID, GUILD_ID, DROP_CHANNEL_ID, STORAGE_FILE
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID || null;
const GUILD_ID = process.env.GUILD_ID || null;
const DROP_CHANNEL_ID = process.env.DROP_CHANNEL_ID || null;
const STORAGE_FILE = process.env.STORAGE_FILE || 'storage.json';

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error('Missing required .env values: DISCORD_TOKEN, CLIENT_ID, OWNER_ID');
  process.exit(1);
}

/* ---------------- CONFIG / TIMING VARIABLES ---------------- */
const VOTE_DURATION_SECONDS = 45;
const TIMEOUT_DURATION_SECONDS = 60;
const COOLDOWN_DURATION_MINUTES = 15;
const IMMUNITY_MINUTES = 15;
const BACKFIRE_COMMAND_COOLDOWN_MINUTES = 15;
const DROP_EXPIRE_HOURS = 48;
const DROP_MESSAGE_LIFETIME_MS = 10 * 1000; // delete drop message after 10 seconds

/* ---------------- STORAGE ---------------- */
const storagePath = path.resolve(STORAGE_FILE);
let storage = {
  userCounts: {},
  activeDrops: {},
  botSettings: {
    autoDropEnabled: !!DROP_CHANNEL_ID,
    dropChannelId: DROP_CHANNEL_ID || null
  }
};

function loadStorage() {
  try {
    if (fs.existsSync(storagePath)) {
      const raw = fs.readFileSync(storagePath, 'utf8') || '{}';
      const parsed = JSON.parse(raw);
      storage = Object.assign(storage, parsed);
      storage.userCounts = storage.userCounts || {};
      storage.activeDrops = storage.activeDrops || {};
      storage.botSettings = storage.botSettings || storage.botSettings;
    } else {
      saveStorage();
    }
  } catch (e) {
    console.error('Failed loading storage, resetting to defaults:', e);
    saveStorage();
  }
}

function saveStorage() {
  try {
    fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2));
  } catch (e) {
    console.error('Failed saving storage:', e);
  }
}

/* ---------------- HELPERS ---------------- */
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const makeDropId = () => `drop_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const buttonIdFor = (dropId, boxIndex) => `collect:${dropId}:${boxIndex}`;

function isOwnerId(id) {
  return String(id) === String(OWNER_ID);
}

function isModeratorByRole(member) {
  if (!MOD_ROLE_ID) return false;
  try {
    return member.roles && member.roles.cache && member.roles.cache.has(MOD_ROLE_ID);
  } catch {
    return false;
  }
}

function isModeratorByPerms(member) {
  try {
    return member.permissions && (
      member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
      member.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
      member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
      member.permissions.has(PermissionsBitField.Flags.KickMembers) ||
      member.permissions.has(PermissionsBitField.Flags.BanMembers)
    );
  } catch {
    return false;
  }
}

function isModerator(interaction) {
  if (isOwnerId(interaction.user.id)) return true;
  if (MOD_ROLE_ID) {
    try {
      if (interaction.member && isModeratorByRole(interaction.member)) return true;
    } catch {}
  }
  return isModeratorByPerms(interaction.member);
}

/* ---------------- CLIENT ---------------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

/* ---------------- COMMANDS ---------------- */
const commands = [
  { name: 'giftbox', description: 'Show how many gift boxes you have collected' },
  {
    name: 'snowball',
    description: 'Throw a snowball at a user and timeout them for 1 minute',
    options: [{ name: 'target', description: 'User to hit', type: 6, required: true }]
  },
  { name: 'drop', description: 'Moderator-only: force a gift drop in this channel' },
  { name: 'force_drop', description: 'Owner-only: force a gift drop in this channel (owner only)' },
  {
    name: 'set_drop_channel',
    description: 'Owner-only: set automatic drop channel',
    options: [{ name: 'channel', description: 'Text channel', type: 7, required: true }]
  },
  { name: 'reset_counts', description: 'Owner-only: reset all user counts' },
  { name: 'toggle_auto', description: 'Owner-only: toggle automatic drops on/off' },
  { name: 'leaderboard', description: 'Show top 20 collectors' }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Registered guild commands for', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global commands (may take up to an hour).');
    }
  } catch (e) {
    console.error('Command registration failed:', e);
  }
}

/* ---------------- ROLE HELP ---------------- */
async function ensureSantaRole(guild) {
  const ROLE_NAME = 'Santa Clone';
  let role = guild.roles.cache.find(r => r.name === ROLE_NAME);
  if (!role) {
    try {
      role = await guild.roles.create({ name: ROLE_NAME, color: 'Random', reason: 'Troll gift role' });
      console.log('Created role Santa Clone in', guild.id);
    } catch (e) {
      console.warn('Could not create Santa Clone role:', e.message);
      role = null;
    }
  }
  return role;
}

/* ---------------- SEND DROP (single message, 4 embeds + buttons) ---------------- */
async function sendGiftDrop(guild, channel) {
  try {
    const dropId = makeDropId();
    const createdAt = Date.now();
    const expiresAt = createdAt + DROP_EXPIRE_HOURS * 60 * 60 * 1000;
    const idx = [0, 1, 2, 3];
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const realIndices = idx.slice(0, 2);
    const validBoxes = realIndices.map(i => `box_${i}`);
    storage.activeDrops[dropId] = { createdAt, expiresAt, validBoxes, collectedBy: {} };

    // Build embeds
    const embeds = [];
    for (let i = 0; i < 4; i++) {
      const isReal = validBoxes.includes(`box_${i}`);
      const embed = new EmbedBuilder()
        .setTitle(`Gift ${i + 1}`)
        .setDescription(isReal ? 'A sparkling gift box! Click Collect.' : 'A mysterious box... click at your own risk.')
        .setColor(isReal ? 0x58D68D : 0xF1948A)
        .setFooter({ text: `Drop ${dropId} • Box ${i + 1}` })
        .setTimestamp();
      embeds.push(embed);
    }

    // Build buttons in a single row
    const buttons = [];
    for (let i = 0; i < 4; i++) {
      const btn = new ButtonBuilder()
        .setCustomId(buttonIdFor(dropId, i))
        .setLabel(`Collect ${i + 1}`)
        .setStyle(ButtonStyle.Primary);
      buttons.push(btn);
    }
    const row = new ActionRowBuilder().addComponents(buttons);

    const sent = await channel.send({ embeds, components: [row] });
    storage.activeDrops[dropId].messageId = sent.id;
    storage.activeDrops[dropId].channelId = channel.id;
    saveStorage();

    // Delete message after DROP_MESSAGE_LIFETIME_MS and mark drop expired
    setTimeout(async () => {
      try {
        if (storage.activeDrops[dropId]) {
          delete storage.activeDrops[dropId];
          saveStorage();
        }
        const ch = await guild.channels.fetch(channel.id).catch(() => null);
        if (ch && ch.isText) {
          await ch.messages.delete(sent.id).catch(() => null);
        }
      } catch (e) {
        console.warn('Failed to cleanup drop message:', e);
      }
    }, DROP_MESSAGE_LIFETIME_MS);

    // safety expiry cleanup
    setTimeout(() => {
      if (storage.activeDrops[dropId]) {
        delete storage.activeDrops[dropId];
        saveStorage();
        console.log(`Expired drop cleaned: ${dropId}`);
      }
    }, Math.max(0, expiresAt - Date.now()));

    console.log(`Drop ${dropId} sent to ${guild.id}/${channel.id} (message ${sent.id})`);
  } catch (e) {
    console.error('sendGiftDrop error:', e);
  }
}

/* ---------------- INTERACTION HANDLING ---------------- */
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      const custom = interaction.customId;
      if (!custom.startsWith('collect:')) return;
      const [, dropId, boxIndex] = custom.split(':');
      const boxId = `box_${boxIndex}`;
      const drop = storage.activeDrops[dropId];
      if (!drop) return interaction.reply({ content: 'This drop expired or is invalid (message removed).', ephemeral: true });
      if (Date.now() > drop.expiresAt) {
        delete storage.activeDrops[dropId];
        saveStorage();
        return interaction.reply({ content: 'This drop has expired.', ephemeral: true });
      }
      if (drop.collectedBy[boxId]) return interaction.reply({ content: 'Someone already collected this box.', ephemeral: true });

      const member = interaction.member;
      if (!member) return interaction.reply({ content: 'Member info missing.', ephemeral: true });

      // NEW: Prevent same user claiming more than one box per drop
      // Check if the user already appears in drop.collectedBy values
      const alreadyClaimed = Object.values(drop.collectedBy || {}).includes(member.id);
      if (alreadyClaimed) {
        return interaction.reply({ content: 'You already claimed a box from this drop. You cannot claim another.', ephemeral: true });
      }

      const claimerMention = `<@${member.id}>`;
      const isReal = drop.validBoxes.includes(boxId);

      // mark collected early to avoid race
      drop.collectedBy[boxId] = member.id;
      saveStorage();

      if (isReal) {
        storage.userCounts[member.id] = (storage.userCounts[member.id] || 0) + 1;
        await interaction.reply({
          content: `${claimerMention} collected a gift box! 🎁 You now have ${storage.userCounts[member.id]} collected.`,
          allowedMentions: { users: [member.id] }
        });
      } else {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: 'Guild context missing.', ephemeral: true });
        const role = await ensureSantaRole(guild);
        if (!role) {
          return interaction.reply({
            content: `${claimerMention} opened a troll box! Could not create/assign Santa Clone role.`,
            allowedMentions: { users: [member.id] }
          });
        }
        try {
          const me = guild.members.me;
          if (me && me.roles.highest.position <= role.position) {
            return interaction.reply({
              content: `${claimerMention} opened a troll box! I cannot assign Santa Clone role due to role hierarchy.`,
              allowedMentions: { users: [member.id] }
            });
          }
          await member.roles.add(role, 'Troll gift: Santa Clone');
          await interaction.reply({
            content: `${claimerMention} opened a troll box and received the Santa Clone role.`,
            allowedMentions: { users: [member.id] }
          });
        } catch (e) {
          console.warn('Role assign failed:', e);
          return interaction.reply({
            content: `${claimerMention} opened a troll box but role assignment failed (missing perms).`,
            allowedMentions: { users: [member.id] }
          });
        }
      }

      // Edit original message to disable the collected button if message still exists
      try {
        const messageId = drop.messageId || interaction.message.id;
        const channelId = drop.channelId || interaction.channel.id;
        const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (ch && ch.isText) {
          const msg = await ch.messages.fetch(messageId).catch(() => null);
          if (msg) {
            const newComponents = msg.components.map(row => {
              const r = ActionRowBuilder.from(row);
              r.components = r.components.map(c => {
                if (c.data && c.data.custom_id === custom) {
                  const nb = ButtonBuilder.from(c);
                  nb.setDisabled(true);
                  nb.setStyle(ButtonStyle.Secondary);
                  return nb;
                }
                return c;
              });
              return r;
            });
            await msg.edit({ components: newComponents }).catch(() => null);
          }
        }
      } catch (e) {
        console.warn('Failed to edit drop message to disable button:', e);
      }

      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;

    if (name === 'giftbox') {
      const cnt = storage.userCounts[interaction.user.id] || 0;
      return interaction.reply({ content: `You have collected **${cnt}** gift box(es).`, ephemeral: false });
    }

    if (name === 'leaderboard') {
      const entries = Object.entries(storage.userCounts || {});
      if (entries.length === 0) return interaction.reply({ content: 'No collectors yet.', ephemeral: false });
      entries.sort((a, b) => b[1] - a[1]);
      const top = entries.slice(0, 20);
      let text = '**Top collectors**\n';
      for (let i = 0; i < top.length; i++) {
        const [uid, cnt] = top[i];
        const rank = i + 1;
        text += `${rank}. <@${uid}> — **${cnt}**\n`;
      }
      return interaction.reply({ content: text, ephemeral: false });
    }

    if (name === 'snowball') {
      const target = interaction.options.getUser('target', true);
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !isOwnerId(interaction.user.id)) {
        return interaction.reply({ content: 'You need Moderate Members permission to use /snowball.', ephemeral: true });
      }
      try {
        const me = guild.members.me;
        if (!me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          return interaction.reply({ content: 'I lack Moderate Members permission.', ephemeral: true });
        }
        const targetMember = await guild.members.fetch(target.id).catch(() => null);
        if (!targetMember) return interaction.reply({ content: 'Target member not found.', ephemeral: true });
        if (me.roles.highest.position <= targetMember.roles.highest.position) {
          return interaction.reply({ content: 'I cannot time out that user due to role hierarchy.', ephemeral: true });
        }
        await targetMember.timeout(TIMEOUT_DURATION_SECONDS * 1000, `Hit by snowball from ${interaction.user.tag}`);
        return interaction.reply({ content: `❄️ ${target.tag} was hit by a snowball and timed out for ${TIMEOUT_DURATION_SECONDS} seconds.`, ephemeral: false });
      } catch (e) {
        console.error('snowball error:', e);
        return interaction.reply({ content: 'Failed to throw snowball. Check permissions and hierarchy.', ephemeral: true });
      }
    }

    // ---------- owner & moderator commands ----------
    if (name === 'drop') {
      if (!isModerator(interaction)) return interaction.reply({ content: 'You need moderator permissions (or owner) to use /drop.', ephemeral: true });
      await interaction.reply({ content: 'Creating drop in this channel...', ephemeral: true });
      await sendGiftDrop(interaction.guild, interaction.channel);
      return;
    }

    if (name === 'force_drop') {
      if (!isOwnerId(interaction.user.id)) return interaction.reply({ content: 'Only the bot owner can use /force_drop.', ephemeral: true });
      await interaction.reply({ content: 'Owner forced a drop in this channel...', ephemeral: true });
      await sendGiftDrop(interaction.guild, interaction.channel);
      return;
    }

    if (name === 'set_drop_channel') {
      if (!isOwnerId(interaction.user.id)) return interaction.reply({ content: 'Only the bot owner can run this command.', ephemeral: true });
      const channel = interaction.options.getChannel('channel', true);
      if (!channel || !channel.isText()) return interaction.reply({ content: 'Please pick a text channel.', ephemeral: true });
      storage.botSettings = storage.botSettings || {};
      storage.botSettings.dropChannelId = channel.id;
      storage.botSettings.autoDropEnabled = true;
      saveStorage();
      return interaction.reply({ content: `Automatic drops set to ${channel.toString()}.`, ephemeral: false });
    }

    if (name === 'reset_counts') {
      if (!isOwnerId(interaction.user.id)) return interaction.reply({ content: 'Only the bot owner can run this.', ephemeral: true });
      storage.userCounts = {};
      saveStorage();
      return interaction.reply({ content: 'All user counts reset.', ephemeral: false });
    }

    if (name === 'toggle_auto') {
      if (!isOwnerId(interaction.user.id)) return interaction.reply({ content: 'Only the bot owner can run this.', ephemeral: true });
      storage.botSettings = storage.botSettings || {};
      storage.botSettings.autoDropEnabled = !storage.botSettings.autoDropEnabled;
      saveStorage();
      return interaction.reply({ content: `Automatic drops are now ${storage.botSettings.autoDropEnabled ? 'enabled' : 'disabled'}.`, ephemeral: false });
    }

  } catch (e) {
    console.error('Interaction handler error:', e);
    try { if (!interaction.replied) await interaction.reply({ content: 'Internal error occurred.', ephemeral: true }); } catch {}
  }
});

/* ---------------- SCHEDULER ---------------- */
client.once('ready', async () => {
  console.log('Logged in as', client.user.tag);
  loadStorage();
  await registerCommands();

  if (storage.botSettings.autoDropEnabled && storage.botSettings.dropChannelId) {
    console.log('Auto drops enabled. Channel ID:', storage.botSettings.dropChannelId);
    scheduleNextDrop();
  } else {
    console.log('Auto drops disabled. Use /set_drop_channel or /toggle_auto to enable.');
  }
});

function scheduleNextDrop() {
  const minutes = randInt(5, 10);
  const delay = minutes * 60 * 1000;
  console.log(`Next automatic drop in ${minutes} minute(s).`);
  setTimeout(async () => {
    try {
      const targetChannelId = storage.botSettings.dropChannelId;
      if (targetChannelId) {
        for (const [gid] of client.guilds.cache) {
          const g = client.guilds.cache.get(gid);
          if (!g) continue;
          const ch = g.channels.cache.get(targetChannelId) || await g.channels.fetch(targetChannelId).catch(() => null);
          if (ch && ch.isText()) {
            await sendGiftDrop(g, ch);
            await sleep(500);
          }
        }
      }
    } catch (e) {
      console.error('Auto drop error:', e);
    } finally {
      scheduleNextDrop();
    }
  }, delay);
}

/* ---------------- START ---------------- */
loadStorage();
client.login(TOKEN).catch(err => {
  console.error('Login failed:', err && err.message ? err.message : err);
  process.exit(1);
});
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const botId = client.user.id;
  const mentioned = message.mentions.has("1434909973858615338");

  if (mentioned) {
    const responses = [
      `🎅 Ho ho ho, ${message.author.username}! Did someone call for a gift?`,
      `🎁 You pinged me, ${message.author.username}? I’ve got something magical in my sleigh.`,
      `✨ Santa’s here! What can I do for you, ${message.author.username}?`,
      `❄️ Feeling festive, ${message.author.username}? Let’s drop some joy!`,
      `🎄 You rang? Santa’s always listening... and ready to deliver!`
    ];
    const reply = responses[Math.floor(Math.random() * responses.length)];
    await message.reply(reply);
  }
});