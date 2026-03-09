# PictoCard

Send customisable greeting cards by email — or straight to a Wii via **WiiLink**.

## Features

- 🎴 Upload any image and add a personal message in one of 12 fun fonts
- 📧 Email verification before sending — no account required
- 🎮 Send cards to a Wii via WiiLink (`mail@pictocard.net`)
- 🤖 Optional Discord integration — send cards to Discord users by DM
- 🍄 Optional Mii face rendered on the card
- 😀 Twemoji support in card text
- 🔒 No emails or images are ever stored on the server

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

Copy the example config and fill in your values:

```bash
cp config.example.js config.js
```

Edit `config.js`:

| Key | Description |
|-----|-------------|
| `port` | HTTP port (default: 3000) |
| `smtp.*` | SMTP settings for sending email |
| `fromEmail` | Sender address (use `mail@pictocard.net` for WiiLink) |
| `sessionSecret` | Random string for session signing |
| `discord.enabled` | Set to `true` to enable Discord integration |
| `discord.token` | Discord bot token |
| `discord.clientId` | Discord application client ID |
| `discord.clientSecret` | Discord application client secret |
| `discord.redirectUri` | OAuth2 redirect URI |

### 3. Add fonts (optional)

Place font files in `data/fonts/`. See [`data/fonts/README.md`](data/fonts/README.md) for the expected filenames.
Fonts from [RiiTag-Next](https://github.com/PretendoNetwork/RiiTag-Next) are recommended.

### 4. Add preset images (optional)

Drop any `.jpg`, `.png`, `.gif` or `.webp` files into `public/images/presets/`.
They will appear in the preset gallery on the home page.

### 5. Run

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## WiiLink Integration

To send a card to a Wii, add **`mail@pictocard.net`** as a contact in your Wii Address Book, then enter that address as the recipient on the PictoCard form.

## Discord Integration

1. Create a Discord application and bot at [discord.com/developers](https://discord.com/developers/applications).
2. Enable `discord.enabled = true` in `config.js` and fill in the bot token and OAuth2 credentials.
3. Invite the bot to a shared server with recipients.
4. Users can opt out at any time with the `/optout` slash command.

## Privacy

PictoCard stores **no personal data**. Session data (images, email addresses, card content) lives only in server memory and is discarded once the card is sent or the server restarts. See the [Privacy Policy](https://pictocard.net/privacy) for details.

## License

See [LICENSE](LICENSE).
