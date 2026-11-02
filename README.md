# claude-agents

Self-hosted Claude agents with a chat UI. Agents run on a schedule or when you message them,
and can propose new agents for you to approve.

## Requirements

- A 64-bit Linux server (NAS, Raspberry Pi 4/5, mini PC) with Docker and Docker Compose v2,
  or a Mac with Docker Desktop to try it out (see [On a Mac](#on-a-mac))
- 4 GB RAM (8 GB with the browser agent)
- Your own Claude Pro/Max subscription or Anthropic API key, and/or a ChatGPT Plus/Pro plan
  (see [Use your ChatGPT plan](#use-your-chatgpt-plan))

## 1. Get a Claude token

On any computer with a browser:

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
```

Copy the token it prints (`sk-ant-oat01-…`). Use your own: runs count against that account.
Only using ChatGPT? Skip this step and see [Use your ChatGPT plan](#use-your-chatgpt-plan).

## 2. Install

Pick one: a Docker UI (OMV Compose, Portainer, Dockge) or the command line.
Replacing an install made before the firewall became a container? See
[Replacing an older install](#replacing-an-older-install) first.

### Option A: Docker UI (recommended)

1. On the server, create a user for the agents' files and note its uid and gid:

   ```bash
   sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin claude-agents
   id claude-agents
   ```

2. Create a stack from [`compose.yaml`](compose.yaml) (paste it, or point the UI at this repo).
3. Set the variables in the UI's environment editor:

   | Variable | Value |
   |---|---|
   | `DATA_DIR` | an absolute folder on the server, e.g. `/srv/dev-disk-by-uuid-…/claude-agents-data` (created if missing) |
   | `UI_PASSWORD` | the chat login, e.g. from `openssl rand -base64 24` |
   | `CLAUDE_CODE_OAUTH_TOKEN` | the token from step 1 (or `ANTHROPIC_API_KEY` for an API key) |
   | `TZ` | your timezone for schedules, e.g. `Europe/Lisbon` (default `UTC`) |
   | `AGENT_UID` / `AGENT_GID` | the uid and gid from step 1 (default `1000`, often your own user) |

   Everything else has a default; the full list is at the top of `compose.yaml`.
   Write a `$` in a value as `$$`.
4. Deploy. The images come from GHCR: while the packages are private, run
   `docker login ghcr.io` on the server once (a GitHub token with `read:packages`).
5. Check the safeguards: copy [`scripts/verify.sh`](scripts/verify.sh) to the server and run
   `sudo bash verify.sh`. Every line should be ✓, including "LAN host … blocked".

On first start the stack creates the folders in `DATA_DIR` and the default agents
(`release-watch`, `agent-architect`, and `ad-master`, which starts disabled).
To change a setting later, edit the variable and redeploy the stack. Data is kept.

**Browser agent:** add `COMPOSE_PROFILES=browser` and its logins as
`BROWSER_SECRETS=OLX_EMAIL=me@example.com;OLX_PASSWORD=...`, redeploy, then `docker exec claude-agents agents enable ad-master`.

### Option B: command line

The repo is private: accept the GitHub invite and sign in to GitHub on the server first (`gh auth login`).

```bash
git clone https://github.com/filipeamorimdev/claude-agents.git
cd claude-agents
sudo ./install.sh
```

Paste the token when asked. At the end the installer prints the chat address and password.
It saves the same variables in `.env` and builds the images on the server.

### On a Mac

Works with Docker Desktop (Apple Silicon or Intel), good for trying it out. `install.sh` is
Linux-only, so put the Option A variables in a `.env` file next to `compose.yaml` and run:

```bash
docker compose up -d
```

- Set `UI_BIND=127.0.0.1` so only this Mac can open the chat, and a different `UI_PORT` if 8090 is taken.
  Skip `AGENT_UID`/`AGENT_GID`: on a Mac the files are always yours.
- The firewall works inside Docker Desktop's VM: the agents can't reach your router, other
  devices, this Mac or other containers. `bash scripts/verify.sh` checks it (no `sudo` needed).
- Agents only run while the Mac is awake and Docker Desktop is open; missed schedules are skipped.
- Also set `COMPOSE_FILE=compose.yaml:compose.mac.yaml` in `.env`. Docker Desktop's shared folders don't
  support file locks between processes, so with the database in `DATA_DIR` the app and `agents`
  commands would lose each other's changes. [`compose.mac.yaml`](compose.mac.yaml) keeps the agents'
  data in a Docker volume instead (Docker Desktop → Volumes); `DATA_DIR/config` stays a normal folder.
- To test a checkout next to an install, use [`compose.dev.yaml`](compose.dev.yaml): its own container
  names (`claude-agents-<name>`, from `COMPOSE_PROJECT_NAME`) and images, with its own `UI_PORT`, `AGENTS_SUBNET` and `DATA_DIR`.

## 3. Use it

Open `http://<server-ip>:8090` and sign in.

- **Chat with an agent:** choose the model and effort under the message box. The agent remembers them.
- **Create an agent or a group:** tap the button next to "Agents" and pick **Agent** or **Group**.
  A new agent gets a random name (change it if you like); write what it should do, pick what it can
  use and tap **Save**. Or ask `agent-architect` to design one, then tap **Approve** under its reply
  (or use **Approvals**).
- **Groups:** a group chat sends every message to each agent in it. Tap a group's name to edit it.
- **Commands anywhere:** type `/` in the search box for commands that aren't tied to one chat, e.g.
  `/ask release-watch what's new?`, `/run`, `/enable`, `/disable`, `/new`, `/group`.
- Type `/help` in any chat for that chat's commands, and `@` to mention an agent.

## Push notifications

Get a notification on your phone or computer whenever an agent run ends (scheduled, chat, group,
CLI or asked by another agent), with its result. These are the browser's own notifications
(Web Push): no app or account needed. Tapping one opens that agent's chat.

1. Open the chat on the device over **https** (see below). On iPhone/iPad (iOS 16.4+) first tap
   Share → **Add to Home Screen** and open Agents from the Home Screen: iOS only allows
   notifications for installed web apps.
2. Tap the bell next to "Agents" → **Turn on notifications here**, and allow them.
3. The device gets a **Confirm this device** notification: tap it. Until it's confirmed it gets
   nothing else, so you know notifications really arrive.

Type `/devices` in the search box for the same as commands (`/devices add`, `/devices test phone`, …).
From the server:

```bash
docker exec claude-agents agents devices              # list, with the last notification and any error
docker exec claude-agents agents devices add phone    # a pairing code: on the phone type /devices pair <code>
docker exec claude-agents agents devices verify phone # send a new confirmation (or: verify phone <code>)
docker exec claude-agents agents devices test phone
docker exec claude-agents agents devices remove phone
```

**https:** browsers only allow notifications on a secure address (or `http://localhost` on the same
computer). Either put a certificate your devices trust in `DATA_DIR/config/tls/` as `cert.pem` and
`key.pem` and redeploy (the chat then serves https on the same port; e.g. `tailscale cert` or
[mkcert](https://github.com/FiloSottile/mkcert) with its root installed on the phone), or put the chat
behind a reverse proxy or `tailscale serve` that does https.

Notifications are end-to-end encrypted to each device, then delivered by its browser's push service
(Apple, Google or Mozilla), which can't read them. If a device turns notifications off, it shows as
disconnected: turn them on again there.

## Use your ChatGPT plan

Agents can also run on OpenAI models (GPT-6.1 Sol, Astra, Terra, Luna) through
[Codex](https://developers.openai.com/codex), counting against your ChatGPT plan instead of API billing.
Claude and OpenAI agents can live side by side; pick the model per agent in the chat.

1. Set `AGENTS_SECCOMP=unconfined` and redeploy (`install.sh` asks, and does this for you).
   Codex sandboxes every command it runs, and its sandbox needs user namespaces, which Docker's
   default seccomp filter blocks. The container stays non-root with all capabilities dropped.
2. Sign in once (it prints a code to enter at the link it shows):

   ```bash
   docker exec -it claude-agents codex login --device-auth
   ```

   The login is saved in `DATA_DIR/agents/home/.codex` and refreshes itself. Use your own account.
3. Pick a GPT model under the message box, or `docker exec claude-agents agents set release-watch model=gpt-6.1-sol`.
   ChatGPT-only? Also set `DEFAULT_MODEL=gpt-6.1-sol` for new agents.

Differences from Claude agents:

- Codex works through shell commands, so Read/Write become sandboxed commands: an agent sees its
  own folder (writable only with Write or Edit) and nothing private (logins, logs, database,
  other agents). It gets network only with WebFetch, and no shell at all without file tools.
- Effort sets the reasoning level and caps the tool calls Codex reports per run (MCP calls, file
  edits, web searches; low 10 … max 100). Shell commands Codex runs through its code tool aren't
  reported, so they don't count. Codex may also start helper sub-agents; they run in the same sandbox.
- Switching an agent between Claude and OpenAI starts a new conversation.
- `CODEX_API_KEY` uses an OpenAI API key instead (billed per token); `CODEX_MODELS` changes the list.
- Ubuntu 23.10+ hosts also restrict user namespaces with AppArmor. If `verify.sh` says the Codex
  sandbox can't start, run `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`
  (add it to `/etc/sysctl.d/` to keep it).

## Update

Docker UI: pull the images and redeploy the stack. If `compose.yaml` changed, paste the new
one into the stack first. Command line:

```bash
cd claude-agents && git pull && sudo ./install.sh
```

The browser image is pinned (`BROWSER_IMAGE`); it changes only when `compose.yaml` bumps it.
Your `DATA_DIR/config/` files and agents are never overwritten by an update.

## Replacing an older install

Installs from before the firewall container used a systemd firewall service and kept settings
in the checkout (`.env`, `config/`, `secrets/`). To start fresh, in that old checkout and
**before** `git pull`:

```bash
sudo ./install.sh --uninstall --purge   # deletes the containers, firewall service, data and settings
```

Then delete the checkout and install with Option A. To keep your agents instead, skip this and
run `git pull && sudo ./install.sh`: it moves the old settings over.

## Uninstall

Docker UI: remove the stack, then lift the firewall rules (or reboot):
`docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW ghcr.io/filipeamorimdev/claude-agents-firewall remove`
(add `-e AGENTS_SUBNET=…` if you changed it).
Command line:

```bash
sudo ./install.sh --uninstall           # add --purge to also delete data and settings
```

## Good to know

- Use the chat on your home network or through a VPN. Don't expose it to the internet.
- Agents can't reach your LAN and only see their own folder. Claude agents get a shell only if you
  grant Bash; OpenAI agents run sandboxed commands (see [Use your ChatGPT plan](#use-your-chatgpt-plan)).
  To let them reach one device (e.g. Home Assistant), set `FIREWALL_ALLOW=192.168.1.50:8123`.
- Agents and MCP servers are configured in `DATA_DIR/config/` (created on first start).
  A variable an MCP server needs (like `HA_TOKEN`) must also be listed in `compose.yaml`.
- Browser logins: use passwords unique to those sites, and no 2FA seeds (the agent asks you for codes).
- Two installs on one host: give each its own `AGENTS_SUBNET` and `UI_PORT`, and its own container
  names. Each install's firewall rules are named after its subnet, so they don't overwrite each other.
- Logs: `docker logs -f claude-agents`. Check the safeguards: `sudo bash scripts/verify.sh`.

## License

[MIT](LICENSE) © Filipe Amorim. Free to use, modify and share, as long as the copyright notice is kept.
