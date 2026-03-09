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

  // Twemoji CDN base URL for emoji images rendered on cards.
  // Update the version tag to access newer emoji sets.
  // See https://github.com/twitter/twemoji for available releases.
  twemojiCdnBase: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72'
};
