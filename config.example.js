module.exports = {
  port: 3000,
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    auth: {
      user: 'your-email@example.com',
      pass: 'your-password'
    }
  },
  fromEmail: 'mail@pictocard.net',
  fromName: 'PictoCard',
  domain: 'https://pictocard.net',
  discord: {
    token: 'YOUR_BOT_TOKEN',
    clientId: 'YOUR_CLIENT_ID',
    clientSecret: 'YOUR_CLIENT_SECRET',
    redirectUri: 'https://pictocard.net/discord/callback',
    enabled: false
  },
  sessionSecret: 'change-this-to-a-random-string',
  verificationCodeExpiry: 10 * 60 * 1000, // 10 minutes in ms

  // OpenAI Moderation API key for adult-content scanning of card text.
  // Leave empty to skip moderation (the check is opt-in).
  // Get a key at https://platform.openai.com/api-keys
  moderationApiKey: '',

  // Twemoji CDN base URL for emoji images rendered on cards.
  // Update the version tag to access newer emoji sets.
  // See https://github.com/twitter/twemoji for available releases.
  twemojiCdnBase: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72',

  // Sentry DSN for automatic error reporting.
  // This can also be set via the SENTRY_DSN environment variable (env var takes precedence).
  // Leave empty to disable Sentry. Get a DSN at https://sentry.io/
  sentryDsn: '',

  // Secret key used when hashing opt-out email addresses (HMAC-SHA512).
  // Set this to a long random string. If left empty a plain SHA-512 is used.
  // Changing this value after people have already opted out will invalidate
  // all existing opt-out entries.
  optoutHashSecret: ''
};
