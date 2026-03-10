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

const BOT_READY_TIMEOUT_MS = 30_000;
const USERNAME_SEARCH_LIMIT = 5;

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
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages
    ]
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

  // Wait for the ready event so the bot is fully connected before initBot resolves
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discord bot ready timeout after 30s')), BOT_READY_TIMEOUT_MS);
    botClient.once('ready', () => {
      clearTimeout(timeout);
      botReady = true;
      console.log(`[Discord] Bot logged in as ${botClient.user.tag}`);
      resolve();
    });
    botClient.login(config.discord.token).catch(err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
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
        const members = await guild.members.search({ query: username, limit: USERNAME_SEARCH_LIMIT });
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

/**
 * Send a 6-digit verification code to a Discord user via DM.
 * @param {string} username - Discord username to look up
 * @param {string} code     - 6-digit verification code
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendVerificationCodeViaDM(username, code) {
  if (!botClient || !botReady) {
    return { success: false, error: 'Discord bot is not connected. Make sure you have invited the bot to a shared server.' };
  }

  try {
    let targetUser = null;
    for (const guild of botClient.guilds.cache.values()) {
      try {
        const members = await guild.members.search({ query: username, limit: USERNAME_SEARCH_LIMIT });
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
      return { success: false, error: `Could not find Discord user "${username}" in any shared server. Make sure the bot is in a server with you.` };
    }

    const dmChannel = await targetUser.createDM();
    await dmChannel.send(
      `🔐 Your PictoCard verification code is: **${code}**\n\nThis code expires in 10 minutes. Do not share it with anyone.`
    );
    return { success: true };
  } catch (err) {
    console.error('[Discord] sendVerificationCodeViaDM error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a delivery confirmation DM to the sender after a card is sent via Discord.
 * Errors are swallowed - confirmation is best-effort.
 * @param {string} senderUsername    - Sender's Discord username
 * @param {string} recipientUsername - Recipient's Discord username
 */
async function sendConfirmationViaDM(senderUsername, recipientUsername) {
  if (!botClient || !botReady) return;

  try {
    let targetUser = null;
    for (const guild of botClient.guilds.cache.values()) {
      try {
        const members = await guild.members.search({ query: senderUsername, limit: USERNAME_SEARCH_LIMIT });
        const match = members.find(m => m.user.username === senderUsername);
        if (match) {
          targetUser = match.user;
          break;
        }
      } catch {
        // Continue
      }
    }

    if (!targetUser) return;
    const dmChannel = await targetUser.createDM();
    await dmChannel.send(`✅ Your PictoCard was successfully delivered to **${recipientUsername}** via Discord!`);
  } catch (err) {
    console.error('[Discord] sendConfirmationViaDM error:', err.message);
  }
}

module.exports = { initBot, isUserOptedOut, sendCardToDiscordUser, sendVerificationCodeViaDM, sendConfirmationViaDM };
