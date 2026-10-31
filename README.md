# claude-agents

Self-hosted Claude agents with a chat UI. Agents run on a schedule or when you message them,
and can propose new agents for you to approve.

## Requirements

- A 64-bit Linux server (NAS, Raspberry Pi 4/5, mini PC) with Docker and Docker Compose v2,
  or a Mac with Docker Desktop to try it out (see [On a Mac](#on-a-mac))
- 4 GB RAM (8 GB with the browser agent)
- Your own Claude Pro/Max subscription or Anthropic API key

## 1. Get a Claude token

On any computer with a browser:

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
```

Copy the token it prints (`sk-ant-oat01-…`). Use your own: runs count against that account.

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

## 3. Use it

Open `http://<server-ip>:8090` and sign in.

- **Chat with an agent:** choose the model and effort under the message box. The agent remembers them.
- **Create an agent:** ask `agent-architect`, then tap **Approve** under its reply (or use **Approvals**).
- **Groups:** the button next to "Agents" creates a group chat. Every agent in it gets each message.
- Type `/help` in any chat for the commands, and `@` to mention an agent.

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
- Agents can't reach your LAN, can't use a shell, and only see their own folder.
  To let them reach one device (e.g. Home Assistant), set `FIREWALL_ALLOW=192.168.1.50:8123`.
- Agents and MCP servers are configured in `DATA_DIR/config/` (created on first start).
  A variable an MCP server needs (like `HA_TOKEN`) must also be listed in `compose.yaml`.
- Browser logins: use passwords unique to those sites, and no 2FA seeds (the agent asks you for codes).
- Logs: `docker logs -f claude-agents`. Check the safeguards: `sudo bash scripts/verify.sh`.

## License

[MIT](LICENSE) © Filipe Amorim. Free to use, modify and share, as long as the copyright notice is kept.
