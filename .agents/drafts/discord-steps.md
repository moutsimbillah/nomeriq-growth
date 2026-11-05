# .agents/drafts/discord-steps.md — item 7: the messaging channel

## Which channels your Hermes version supports

v0.22.6 supports all three you asked about. Tested/read from this install:

| Channel | Supported | What it needs | Verdict for you |
| --- | --- | --- | --- |
| **Discord** | yes | A bot token (2 clicks) + your user ID. No phone, no business account, no public URL. | **Best fit** |
| **WhatsApp** (Baileys bridge) | yes | Emulates WhatsApp Web from your own number; unofficial, carries a real account-restriction risk, and needs a Node bridge process running. | Avoid |
| **Email** | yes | SMTP host, port, address and an app password. Reports arrive as mail; approvals-by-email are awkward and slow. | Backup only |
| Telegram | yes in Hermes, but unusable for you — blocked in Pakistan. | — | Not an option |

**Recommendation: Discord**, for reports and approvals. It is the only one with no phone
number, no ban risk, no public webhook and no mail-provider limits.

## The exact steps — you do these, not me

### 1. Create the application
1. Go to https://discord.com/developers/applications and sign in.
2. **New Application** → name it (e.g. `Growth Ops`) → accept the terms → **Create**.

### 2. Create the bot
3. Left sidebar → **Bot**. Discord creates the bot user automatically.
4. Under **Authorization Flow**: **Public Bot** = **ON**, **Require OAuth2 Code Grant** = **OFF**.

### 3. Enable the two privileged intents — this is the step that breaks bots
5. On the same **Bot** page, scroll to **Privileged Gateway Intents**.
6. Turn **Message Content Intent** **ON** — Hermes always asks for message content, and
   Discord **refuses the connection entirely** if it is off.
7. Turn **Server Members Intent** **ON** — without it the bot cannot resolve your username
   to a user ID.
8. **Save Changes**.

### 4. Get the token
9. **Bot** page → **Token** → **Reset Token** → (2FA if you have it) → **Copy**.
   It is shown **once**. Put it in your password manager now.

### 5. Invite the bot to your server
10. Left sidebar → **Installation** → **Installation Contexts**: enable **Guild Install**.
11. **Install Link** → *Discord Provided Link*. Scopes: `bot` + `applications.commands`.
    Permissions: at minimum View Channels, Send Messages, Embed Links, Attach Files,
    Read Message History. (Or paste this URL with your Application ID:
    `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=309237763136`)
12. Open the URL, pick your server, **Continue** → **Authorize**. (You need Manage Server.)

### 6. Get your own user ID and a channel ID
13. In the Discord app: **Settings → Advanced → Developer Mode ON**.
14. Right-click your own name → **Copy User ID**.
15. Create a channel like `#growth-ops`, right-click it → **Copy Channel ID**.

### 7. Put the values in Hermes yourself
Add these three lines to `C:\Users\Welcome\AppData\Local\hermes\.env`:

```
DISCORD_BOT_TOKEN=<paste the token from step 9>
DISCORD_ALLOWED_USERS=<your user ID from step 14>
DISCORD_HOME_CHANNEL=<the channel ID from step 15>
```

**Do not paste any of these three values into this chat.** I never need to see them, and I
will not accept them if they are sent. After saving, tell me "done" and I will:

- verify the token works by checking `hermes gateway status` and the gateway log (no secret printed),
- set `DISCORD_HOME_CHANNEL_NAME` for readable logs,
- point the daily check and the weekly summary at the Discord home channel,
- confirm cron approvals are still `deny` on Discord (`approvals.cron_mode: deny` applies
  to unattended platforms — a Discord message can never silently approve a dangerous command).

### Alternative if you prefer the guided path
`hermes gateway setup` → pick **Discord** → it verifies the token with Discord, tells you if
Message Content Intent is off, prints the invite link, and allowlists you as owner. You still
type the token yourself. Either route is fine; the manual one above is explicit about every value.
