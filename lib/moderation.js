'use strict';

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

/**
 * Check card text against the OpenAI Moderation API.
 * Returns true if the text is flagged as inappropriate.
 * Silently returns false (never blocks) if the API key is not configured or the request fails.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function checkContentModeration(text) {
  if (!config.moderationApiKey || !text || !text.trim()) return false;
  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.moderationApiKey}`
      },
      body: JSON.stringify({ input: text.trim() })
    });
    if (!response.ok) return false;
    const data = await response.json();
    return !!(data.results && data.results[0] && data.results[0].flagged);
  } catch {
    return false;
  }
}

module.exports = { checkContentModeration };
