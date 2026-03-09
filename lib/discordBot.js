'use strict';

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

// In-memory opt-out set (no persistence)
const optedOutUsers = new Set();

let botClient = null;
let botReady = false;

/**
 * Register slash commands and initialise the Discord bot.
 * Only connects if config.discord.enabled is true.
 */
async function initBot() {
  if (!config.discord || !config.discord.enabled) {
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('optout')
      .setDescription('Opt out of receiving PictoCards via Discord DMs')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('optin')
      .setDescription('Opt back in to receiving PictoCards via Discord DMs')
      .toJSON()
  ];

  // Register commands globally
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  try {
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commands });
  } catch (err) {
    console.error('[Discord] Failed to register slash commands:', err.message);
  }

  botClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]
  });

  botClient.once('ready', () => {
    botReady = true;
    console.log(`[Discord] Bot logged in as ${botClient.user.tag}`);
  });

  botClient.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const username = interaction.user.username;

    if (interaction.commandName === 'optout') {
      optedOutUsers.add(username);
      await interaction.reply({
        content: '✅ You have opted out of receiving PictoCards via Discord. Use `/optin` to reverse this.',
        ephemeral: true
      });
    } else if (interaction.commandName === 'optin') {
      optedOutUsers.delete(username);
      await interaction.reply({
        content: '✅ You have opted back in to receiving PictoCards via Discord.',
        ephemeral: true
      });
    }
  });

  await botClient.login(config.discord.token);
}

/**
 * Check whether a Discord username has opted out.
 * @param {string} username - Discord username (without discriminator)
 * @returns {boolean}
 */
function isUserOptedOut(username) {
  return optedOutUsers.has(username);
}

/**
 * Send a greeting card to a Discord user by username via DM.
 * @param {string} username           - Discord username to look up
 * @param {string} senderDisplayName  - The sender's chosen display name
 * @param {string} message            - Message to include
 * @param {Buffer} cardImageBuffer    - PNG image buffer
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendCardToDiscordUser(username, senderDisplayName, message, cardImageBuffer) {
  if (!botClient || !botReady) {
    return { success: false, error: 'Discord bot is not connected.' };
  }

  if (isUserOptedOut(username)) {
    return { success: false, error: 'That user has opted out of receiving cards via Discord.' };
  }

  try {
    // Fetch user by username – requires guild membership. Try searching all cached guilds.
    let targetUser = null;
    for (const guild of botClient.guilds.cache.values()) {
      try {
        const members = await guild.members.search({ query: username, limit: 5 });
        const match = members.find(m => m.user.username === username);
        if (match) {
          targetUser = match.user;
          break;
        }
      } catch {
        // Continue searching other guilds
      }
    }

    if (!targetUser) {
      return { success: false, error: `Could not find Discord user "${username}" in any shared server.` };
    }

    const dmChannel = await targetUser.createDM();
    const attachment = new AttachmentBuilder(cardImageBuffer, { name: 'pictocard.png' });

    const content = message
      ? `🎉 **${senderDisplayName}** sent you a PictoCard!\n\n${message}`
      : `🎉 **${senderDisplayName}** sent you a PictoCard!`;

    await dmChannel.send({ content, files: [attachment] });
    return { success: true };
  } catch (err) {
    console.error('[Discord] sendCardToDiscordUser error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { initBot, isUserOptedOut, sendCardToDiscordUser };
