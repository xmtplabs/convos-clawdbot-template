# OpenClaw Railway Template (Convos)

1‑click deploy for **OpenClaw** on Railway with **/setup** wizard. Uses the [Convos channel](https://github.com/xmtplabs/openclaw/blob/feat/xmtp-and-convos-extensions/docs/channels/convos.md).

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/FO1OkS?referralCode=UxaXte&utm_medium=integration&utm_source=template&utm_campaign=generic)

### Setup

> Convos extension is not in upstream OpenClaw yet. Use the [xmtplabs/openclaw](https://github.com/xmtplabs/openclaw) fork, branch `feat/xmtp-and-convos-extensions` ([PR #2](https://github.com/xmtplabs/openclaw/pull/2)).

**Option A — Invite link from Convos iOS**: Copy an invite URL from the app, then run `openclaw configure` and paste it.

**Option B — /setup page**: Deploy this template, use the **/setup** page to create a conversation and get an invite URL/QR.

### Commands

| Command | Args | Description |
|---------|------|-------------|
| `/invite` | optional name | Create a new Convos conversation and get an invite link |
| `/join` | `<invite-url>` | Join a Convos conversation via invite URL |

### Actions

| Action | Params | Description |
|--------|--------|-------------|
| `send` | `to`, `message` | Send a text message to a conversation |
| `react` | `conversationId`, `messageId`, `emoji`, `remove` | Add/remove a reaction on a message |

### Config

| Key | Default | Description |
|-----|---------|-------------|
| `privateKey` | auto-generated | XMTP private key (hex) |
| `env` | `production` | `production` or `dev` |
| `dmPolicy` | `pairing` | `pairing`, `allowlist`, `open`, `disabled` |
| `groupPolicy` | `open` | `open`, `disabled`, `allowlist` |
| `ownerConversationId` | — | Conversation ID for owner channel |
| `reactionLevel` | — | `off`, `ack`, `minimal`, `extensive` |
| `historyLimit` | — | Max group messages for history context |
| `dmHistoryLimit` | — | Max per-sender turns for history context |
