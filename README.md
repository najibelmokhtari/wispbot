# WhatsApp Group Bot

An AI-powered WhatsApp group chat bot with a web-based admin panel. Built with [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) and Google Gemini (or Claude).

> **Disclaimer:** This project uses whatsapp-web.js, an unofficial WhatsApp client. Using it may violate WhatsApp's Terms of Service. Use at your own risk.

---

## Features

- **AI responses** — Mention the bot in any group message and it replies using Gemini or Claude
- **Per-group configuration** — Each group has its own AI model, persona, and feature flags
- **Custom personas** — Hot-swappable AI personalities via prompt files
- **Message batching** — Groups rapid messages into a single context window before replying
- **Text-to-speech** — Generate audio responses via Google Cloud TTS
- **Image understanding** — Reads and describes images sent in the chat
- **Web search** — Can search the web and summarize results
- **Group memory** — Background processor summarizes and persists group memories
- **Admin panel** — Web UI to manage groups, users, settings, and view the QR code
- **Authorization** — Per-user whitelist, per-group auth toggles
- **Token usage tracking** — Per-user API cost logging

---

## Prerequisites

- Node.js 18+
- Google Gemini API key ([get one here](https://aistudio.google.com/))
- (Optional) Anthropic API key for Claude
- (Optional) Google Cloud service account with Cloud TTS enabled
- A WhatsApp account dedicated to the bot

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/najibelmokhtari/wispbot.git
cd wispbot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in at minimum:

```env
GEMINI_API_KEY=your_gemini_api_key_here
BOT_NAME=MyBot
```

See `.env.example` for all available options.

### 3. Start the bot

```bash
npm start
```

On first run, a QR code will appear in the terminal. Scan it with the WhatsApp account you want to use as the bot.

### 4. (Optional) Admin panel

The admin panel runs automatically at `http://localhost:3000`. Set `ADMIN_PASSWORD` in your `.env` to protect it.

---

## Production Deployment (PM2)

```bash
# Install PM2
npm install -g pm2

# Copy and edit the ecosystem config
cp ecosystem.config.js.example ecosystem.config.js
# Or just start directly:
pm2 start src/bot.js --name whatsapp-bot

pm2 save
pm2 startup
```

Shell scripts for common operations are in `shell/prod/`:

| Script | Action |
|---|---|
| `shell/prod/start_bot.sh` | Install deps and start via PM2 |
| `shell/prod/restart_bot.sh` | Restart the bot |
| `shell/prod/stop_bot.sh` | Stop the bot |
| `shell/prod/show_logs.sh` | Tail PM2 logs |
| `shell/prod/deploy.sh` | Pull latest code and restart |
| `shell/prod/qr.sh` | View QR code from logs |

---

## Bot Commands

All commands are prefixed with `!` and can only be used by authorized admins (unless specified).

| Command | Description |
|---|---|
| `!ping` | Check if the bot is alive |
| `!switch <persona>` | Switch AI persona for the current group |
| `!model <model>` | Change the AI model for the current group |
| `!clear` | Clear the conversation history for this group |
| `!remember <N>` | Set how many messages the bot remembers (max 500) |
| `!search <query>` | Search the web and summarize results |
| `!audio` | Toggle audio/image processing on/off |
| `!tts` | Toggle text-to-speech responses on/off |
| `!usage` | Show token usage stats |
| `!setup-group` | Register a group in the database |
| `!group-id` | Show the current group's WhatsApp ID |
| `!set-group-name <name>` | Set a display name for the group |
| `!authorize-all` | Authorize all current group members |
| `!check-authorized` | List authorized users in this group |
| `!list-add-requests` | Show pending join requests |
| `!accept-add-request <id>` | Accept a specific join request |
| `!list-messages` | Show recent stored messages |

---

## Personas

Persona files live in `prompts/personas/`. Each file is a plain-text system prompt. Switch between them at runtime with `!switch <filename_without_extension>`.

To create a new persona, add a file like `prompts/personas/my_persona.txt` and use `!switch my_persona`.

An example persona structure:

```
You are an AI assistant integrated into a WhatsApp group chat.
[Describe the personality, language preferences, tone, etc.]
```

---

## Group Context Files

Each group can have a context file at `prompts/group_contexts/<group_id>.txt` that provides the bot with background about the group. See `prompts/group_contexts/example.txt` for the format.

---

## Architecture

```
src/
├── bot.js                  # Entry point, WhatsApp client setup
├── config.js               # All config loaded from env vars
├── message-queue.js        # Batches messages, calls AI, sends replies
├── message-processor.js    # Routes messages to commands or AI
├── background-processor.js # Async memory summarization
├── conversation-store.js   # Per-group message history
├── db.js                   # SQLite database layer
├── ai/
│   ├── gemini.js           # Gemini API client
│   └── claude.js           # Claude API client
├── commands/               # One file per bot command
├── admin/                  # Express admin panel
├── services/
│   ├── auth.js             # Authorization logic
│   └── tts.js              # Text-to-speech
└── cli/                    # Operational CLI scripts
```

Data is stored in SQLite (`data/bot.db`) with WAL mode for concurrency.

---

## Environment Variables

See `.env.example` for a full list with descriptions.

**Required:**
- `GEMINI_API_KEY` — Google Gemini API key

**Important optional:**
- `ADMIN_PASSWORD` — Password for the admin panel (default: none)
- `ADMIN_SESSION_SECRET` — Secret for session signing (use a random string in production)
- `BOT_NAME` — Display name of the bot
- `AI_PROVIDER` — `gemini` (default) or `claude`
- `GOOGLE_SERVICE_ACCOUNT_JSON` — JSON string for Google Cloud TTS

---

## Author

Created and maintained by **Najib El Mokhtari** — [@najibelmokhtari](https://github.com/najibelmokhtari)

---

## License

MIT © Najib El Mokhtari
