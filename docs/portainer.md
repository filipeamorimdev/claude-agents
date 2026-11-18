# Deploy with Portainer (kept in sync with this repo)

This sets up a normal Portainer stack: you see and manage it under **Stacks** like any other, its settings are
editable variables in Portainer, and an update is one click. Notes for **TrueNAS SCALE** (Portainer installed
as a TrueNAS app) are marked as such. Prefer a script? `sudo bash scripts/portainer.sh` creates the same stack.

## 0. Before you start

- **The images must match the code.** Portainer pulls `ghcr.io/filipeamorimdev/claude-agents:latest` and
  `claude-agents-firewall:latest`. GitHub builds both on every push to `main`. After a push, wait for the
  **images** workflow to go green (repo → Actions) before deploying.
- **A Claude token** from `claude setup-token` (`sk-ant-oat01-…`), or an API key, or a ChatGPT plan
  (see [Use your ChatGPT plan](../README.md#use-your-chatgpt-plan)).
- **No GitHub login needed.** The repo and both images are public, so Portainer needs no tokens and no registry.

## 1. A folder for the data

The stack keeps everything (database, workspaces, logs, logins, config) in one folder on the host: `DATA_DIR`.

- **TrueNAS:** Datasets → pick your pool → **Add Dataset** → name `claude-agents`, preset **Generic**. Don't use
  the SMB preset: its permission mode blocks the `chmod` the stack needs. The path is
  `/mnt/<pool>/claude-agents`.
- **Other Linux hosts:** any absolute folder, e.g. `/opt/claude-agents-data`. It's created if it's missing.

## 2. Pick the user that owns the files

- **TrueNAS:** use the built-in **apps** user: uid `568`, gid `568`. Don't create one in the TrueNAS shell;
  users made there disappear on the next update.
- **Other hosts:** `sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin claude-agents`,
  then `id claude-agents` for the uid and gid. `1000:1000` also works; that's usually your own user.

You don't set any folder permissions yourself: the stack's `init` step does that on every start.

## 3. Create the stack

Portainer → your environment (**local**) → **Stacks** → **Add stack**:

1. **Name:** `claude-agents`
2. **Build method: Repository**. This way Portainer reads `compose.yaml` from the repo, so updates to it arrive
   with "Pull and redeploy" and you never paste it again.
   - Repository URL: `https://github.com/filipeamorimdev/claude-agents`
   - Repository reference: `refs/heads/main`
   - Compose path: `compose.yaml`
   - Authentication: off (the repo is public).
   - **GitOps updates: off.** Portainer would redeploy as soon as you push, before GitHub has finished
     building the new images, and start the new compose with the old images.
3. **Environment variables** → **Advanced mode**, and paste (fill in yours):

   ```ini
   DATA_DIR=/mnt/<pool>/claude-agents
   UI_PASSWORD=<a long random password: openssl rand -hex 16>
   CLAUDE_CODE_OAUTH_TOKEN=<sk-ant-oat01-…>
   TZ=Europe/Lisbon
   AGENT_UID=568
   AGENT_GID=568
   UI_PORT=8090
   ```

   - **Values:** no `$`, quotes or spaces. Use letters and digits for the password; `openssl rand -hex 16` gives
     you that.
   - **Optional:**
     - `COMPOSE_PROFILES=browser`: the browser agent.
     - `AGENTS_SECCOMP=unconfined`: OpenAI models through your ChatGPT plan.
     - `ANTHROPIC_API_KEY=…`: use this instead of the OAuth token.
   - **Defaults:** everything else has one. The full list is at the top of [`compose.yaml`](../compose.yaml).
4. **Deploy the stack.** The first deploy pulls about 1 GB, so give it a few minutes.

**If the deploy fails:**
- "port is already allocated": set another `UI_PORT`.
- "Pool overlaps with other one on this address space": the stack's networks clash with a network that
  already exists. Look in **Networks** for a `172.30.x.x` one, then add these variables with a free number
  in place of 31:
  ```ini
  AGENTS_SUBNET=172.31.0.0/24
  SHELL_SUBNET=172.31.1.0/24
  LAN_GATEWAY_IP=172.31.1.250
  BROWSER_LAN_SUBNET=172.31.2.0/24
  LAN_GATEWAY_BROWSER_IP=172.31.2.250
  LAN_BROWSER_IP=172.31.2.10
  ```

## 4. Check it

In the stack's page, the containers should show:

| Container | Expected |
|---|---|
| `claude-agents-init-1` | **exited** (0). It's a one-shot setup, so that's normal. |
| `claude-agents-firewall` | **healthy**. Its logs say `using iptables-nft` or `using iptables-legacy`. |
| `claude-agents`, `claude-agents-shell`, `claude-agents-lan` | **running**. The latter two show healthy. |
| `claude-agents-vault`, `browser-admaster` | **running**, only with `COMPOSE_PROFILES=browser`. |

Open `http://<server-ip>:8090` and sign in with `UI_PASSWORD`.

**Full safeguard check (optional, from the host's shell; TrueNAS: System → Shell):**

```bash
sudo bash verify.sh
```

Copy [`scripts/verify.sh`](../scripts/verify.sh) to the host first. Every line should be ✓, including
"LAN host … blocked".

## 5. One-time commands, from Portainer

Containers → `claude-agents` → **Console** → Connect (`/bin/sh`):

- Turn on the browser agent: `agents enable ad-master`
- Sign in to your ChatGPT plan: `codex login --device-auth`
- Everything else: `agents help`

## Updating and changing settings

- **New version:**
  1. Push to `main`.
  2. Wait for the **images** workflow to go green.
  3. Stacks → `claude-agents` → **Pull and redeploy**, with **Re-pull image** on.
- **A setting:** Stacks → `claude-agents` → edit the variable → **Pull and redeploy**.
- **Data:** an update or redeploy keeps everything in `DATA_DIR`.
- **Agent and connector config:** `DATA_DIR/config/` (`agents.mjs`, `mcp-servers.mjs`). Edit, then restart the
  `claude-agents` container.
- **https** (phones need it for push notifications): put `cert.pem` and `key.pem` in `DATA_DIR/config/tls/` and
  restart the `claude-agents` container.
