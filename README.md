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

### Portainer: the setup wizard (easiest)

On the server Portainer manages, from a checkout of this repo:

```bash
sudo bash scripts/portainer.sh
```

It asks for your Claude token and a Portainer access token (or your Portainer login). It works out everything else: the system user and its
uid/gid, the timezone, a free port, free subnets, a chat password, and which Portainer environment is this
host. It also checks that the images on GHCR match this `compose.yaml` (if they don't, push to `main` and
wait for the `images` workflow). Then it creates the stack in Portainer, runs the safeguard checks, and prints
the chat address and password. Re-run it to change a setting or to update; it keeps what you set before.
`--env-only` just writes the variables to a file to load in Portainer's stack editor. `--help` lists the rest.

Step by step in Portainer's own screens (stack kept in sync with this repo), TrueNAS SCALE included:
[docs/portainer.md](docs/portainer.md).

### Option A: Docker UI (by hand)

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
4. Deploy. The images are public on GHCR, so no registry login is needed.
5. Check the safeguards: copy [`scripts/verify.sh`](scripts/verify.sh) to the server and run
   `sudo bash verify.sh`. Every line should be ✓, including "LAN host … blocked".

On first start the stack creates the folders in `DATA_DIR` and the default agents
(`release-watch`, `agent-architect`, and `ad-master`, which starts disabled).
To change a setting later, edit the variable and redeploy the stack. Data is kept.

**Browser agent:** add `COMPOSE_PROFILES=browser`, redeploy, then `docker exec claude-agents agents enable ad-master`.
Add its site logins in the chat (key icon), or wait for it to ask: see [Site logins](#site-logins).

### Option B: command line


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

- **Chat with an agent:** every message uses the model and effort set in the agent's details (tap its name to change them).
- **Create an agent or a group:** tap the button next to "Agents" and pick **Agent** or **Group**.
  A new agent gets a random name (change it if you like); write what it should do, pick what it can
  use and tap **Save**. Or ask `agent-architect` to design one, then tap **Approve** under its reply
  (or use **Approvals**).
- **What an agent can use:** every agent can always read and search the files in its own folder and
  search the web. Anything more (writing files, opening web pages, connectors) you tick in its details,
  or the agent asks for it in the chat and you tap **Approve** under its reply.
- **Ask me first:** in an agent's details, tick the tools it must ask you about before each use
  (writing files, shell, opening pages, a connector, its browser). It stops mid-task and waits: a card in its
  chat and in **Approvals** (plus a notification) with exactly what it's about to do, and **Allow once**,
  **Always allow** or **Deny**. Every agent also asks for your OK by itself before anything irreversible or
  public you didn't ask for (publishing, sending, buying, deleting). No answer within
  `APPROVAL_TIMEOUT_MINUTES` (30) is a no.
- **Memory:** agents keep short notes between runs (what you prefer, facts they looked up, where they
  left off) and see them on every run, scheduled ones included. You see and edit them in its details (or `/memory`).
- **Delegation:** an agent with "Manage agents" can hand tasks to other agents (`delegate`). They run in
  the background, several at once; each task shows under its reply with its status and result, and in the
  other agent's chat. Results it didn't wait for come back to it in one follow-up message.
- **Activity:** everything your agents did, newest first: what each run was asked, every command and
  other tool call with its input and result, what the agent said and thought, how the run ended, and every
  change, approval, memory edit, webhook, task and message between agents. Filter by agent or kind, search
  it, tap **run N** to see one run, tap an entry for all of it. (`agents log` shows the same; tool calls
  and changes are also in `docker logs`.)
- **Terminal commands:** every agent can ask to run a command (`run_command`). You see the exact command,
  the agent, its reason and what it could reach on your network in the chat (and in Approvals, with a push
  notification) and tap **Run it**, **Always allow this command** or **Deny**. No answer in time is a no.
  Commands run in the **command sandbox**, a separate container (`claude-agents-shell`) that has only the
  agents' workspace folders, the internet and a few tools (`curl`, `jq`, `dig`, `ping`, `nc`, `ssh`): no
  database, no logs, no config, no vault, none of the stack's variables, and no route to your LAN, this host,
  the vault or the browsers. So a command you approved by mistake still can't read your secrets or touch the
  log. It only takes commands the app signed (a key only the app holds), so an agent can't slip one in from
  elsewhere. The request, who (or which rule) approved it and when, the command, its exit code and its output
  are all in Activity.
- **Commands without asking** (off by default): in an agent's details, under *Commands without asking*, add
  rules for that agent: *Exactly* a command (`df -h`) or anything that *Starts with* one (`git status`,
  `lan curl -s http://192.168.1.50:8123/api/`), and whether it may use your network then (none, read-only,
  full). **Always allow this command** on a request adds an *Exactly* rule. Only plain commands match: any
  `;` `&` `>` `<` `$` `` ` `` `(` `)` still asks, a pipeline (`a | b`) needs every part to match, and anything
  about the log, the database, the agents CLI or purging always asks, whatever the rules say. Each one is in
  Activity as *Auto-approved by rule #N*. Agents can't
  add rules. **Read-only commands** (a switch in the same place, off by default): commands that only read inside
  the agent's own folder (`ls`, `cat`, `grep`, `rg`, `find`, `jq`, `wc`, `du`, `diff`, `sort`…, alone or piped) run
  without asking, with no network. Anything that writes or deletes, uses the internet or your
  devices (`curl`, `lan`, `ssh`), looks outside its folder (`..`, `~`, other paths), or can run other programs
  (`git`, `sed`, `awk`, `find -exec`, scripts) still asks. CLI: `agents commands <name> read-only on|off`,
  `agents commands <name>`, `agents commands <name> allow [--prefix] [--lan read|full] <command>`,
  `agents commands remove <id>`.
- **Your home network**: agents can't reach anything there until they ask in the chat and you grant that one
  device. See [Home network](#home-network).
- **The log is append-only.** Agents add to it by running and can read their own entries (`read_log`);
  no agent tool changes or deletes an entry, and the database refuses any change or delete that isn't
  your purge. Nothing is removed automatically. Only you purge it: **Purge…** on the Activity page (asks
  for your password) or `docker exec -it claude-agents agents logs purge [--older-than DAYS] [--agent NAME]`
  (asks you to type "purge"). The purge itself stays on record.
- **Groups:** a group chat sends every message to each agent in it. Tap a group's name to edit it.
- **Commands anywhere:** type `/` in the search box for commands that aren't tied to one chat, e.g.
  `/ask release-watch what's new?`, `/run`, `/enable`, `/disable`, `/new`, `/group`, `/activity`.
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

## Webhooks

A webhook starts an agent when something happens elsewhere: a push on GitHub, a Home Assistant
automation, an IFTTT or n8n flow, a script. In the agent's details, under **Webhooks**, give it a name
and tap **Create**: you get a secret address like `https://<your-chat>/hooks/Xy3…`, shown once (the
address is the key; the app keeps only a hash of it).

A `POST` to that address starts a run with what was sent (body up to 64 KB, plus the query string and
`X-…` headers like `X-GitHub-Event`). The agent is told it's data from outside, never instructions, and
does what its own instructions say for such an event; the result lands in its chat like a scheduled run.
Each webhook starts at most 30 runs an hour, and can be turned off or deleted any time.

The chat itself stays on your network. To receive webhooks from the internet, publish **only** the
`/hooks/` path, e.g. `tailscale funnel` with a path, or a reverse proxy location:

```nginx
location /hooks/ { proxy_pass http://<server-ip>:8090; }
```

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
3. Pick a GPT model in the agent's details (tap its name), or `docker exec claude-agents agents set release-watch model=gpt-6.1-sol`.
   ChatGPT-only? Also set `DEFAULT_MODEL=gpt-6.1-sol` for new agents.

Differences from Claude agents:

- Codex works through shell commands, so Read/Write become sandboxed commands: an agent sees its
  own folder (writable only with Write or Edit) and nothing private (logins, logs, database,
  other agents). It gets network only with WebFetch; its shell is read-only without Write or Edit.
- Effort sets the reasoning level and caps the tool calls Codex reports per run (MCP calls, file
  edits, web searches; low 10 … max 100). Shell commands Codex runs through its code tool aren't
  reported, so they don't count. Codex may also start helper sub-agents; they run in the same sandbox.
- Switching an agent between Claude and OpenAI starts a new conversation.
- Codex can't pause a tool call for your OK, so tools set to **Ask me first** aren't given to an
  OpenAI agent at all. Asking for your OK by itself (`request_approval`) works the same.
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

The browser image runs Debian's Chromium; pulling it gets Chromium's latest security fixes. Its
Playwright MCP version is pinned in `browser/Dockerfile` and changes only when that file bumps it.
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

## Site logins

The browser agent signs in to websites with logins kept in a **vault**: its own container that
stores them encrypted (AES-256-GCM) in `DATA_DIR/vault`, which no other container mounts.

- **Add or change them in the chat**: the key icon next to the bell (or `/logins`). You type the value
  there and it goes straight to the vault; it never enters the database, the logs or an agent's context.
- **Agents ask when they need one.** An agent that has to sign in somewhere new calls `request_login`:
  a form appears under its reply with the fields that site needs (e.g. Email, Password). Save it and
  the agent carries on by itself. The form can also let the browser open that site.
- **Agents only see names**, like `VINTED_PASSWORD`. They type the name into the sign-in form and the
  browser types the real value, and hides it from what it shows the agent.
- **Each login works only for the agents you allow.** Saving a login an agent asked for allows that
  agent; tick others under the key icon. Logins from `BROWSER_SECRETS` start with no agent: tick the
  ones that may use them.
- **Each agent has its own browser**, with its own cookies and sign-ins (`DATA_DIR/browsers/profiles/<agent>`)
  and only the logins it's allowed. One agent can't use a site where another is signed in. A browser
  starts when its agent first needs it and stops after `BROWSER_IDLE_MINUTES` (30) unused; at most
  `BROWSER_MAX_AGENTS` (3) run at once. Screenshots go to `DATA_DIR/browsers/shots/<agent>` (a file name an agent
  gives keeps only its name, in that folder: its own paths don't exist in the browser's container).
- **Watch it, or take over.** The screen icon in its chat (or `/browser`) shows its page live. Tick
  **Take control** to click, scroll and type in it yourself. When a site needs something only you can do
  (a captcha, a code sent to you), the agent calls `request_takeover`: a card asks you to open its browser,
  do it, and tap **Done, hand it back**, and it carries on from there.
  While you have control from that card, its page runs in plain Chromium that nothing automates (the agent waits),
  because some sign-in pages (OLX's, Vinted's) refuse any browser Playwright drives and show a person a slider check at
  most: drag on the picture to slide it. What you sign in to stays in its profile; it gets its own browser back when you
  answer the card. A browser restart (new logins, a takeover) keeps the agent's session going.
- **It looks like an ordinary browser here**: Chromium's normal user agent (CloudFront sites like OLX and Wallapop
  answer "HeadlessChrome" with a 403), in `BROWSER_LOCALE` (pt-PT) and `BROWSER_TIMEZONE` (the stack's `TZ`).
  Nothing else is hidden: it's still a Playwright browser, and sites that check for that can still tell.
- The browser opens pages only on its sites, listed in the agent's details under *What it can reach* → *In its
  browser*: `BROWSER_ALLOWED_ORIGINS` plus the ones you add there or allow when saving a login it asked for
  (`https://www.vinted.pt`, `vinted.pt`, or `*.vinted.pt`), and on the devices on your network you granted it. A page on
  one of them loads its images, scripts and sign-in frames from anywhere, never from your network.
  Saving a login restarts that agent's browser (a few seconds); saving a site restarts them all.
- Agents can't run their own code in the browser: a guard in front of the browsers drops Playwright's tools that
  could expose a login (`browser_run_code_unsafe`, `browser_evaluate` and the network log).
- Encrypted, not hashed: the browser has to type the real password. The key (`vault.key`) sits next
  to the logins in `DATA_DIR/vault`, so keep that folder out of shared backups.
- `BROWSER_SECRETS` (`NAME=value;NAME=value`) still works for logins you'd rather set as a variable;
  they show in the chat as *from the stack's variables*.

## Home network

Nothing on your network is reachable by default. It all happens in the chat, no separate settings page:

1. **Ask the agent** ("check my Home Assistant at 192.168.1.50"). It calls `request_network_access` with the
   address (one IP and one port, or a URL; never a whole network), why, and read-only or full.
   One grant covers its commands (`lan`, `lan-ssh`) and its browser alike. You get a card: *Grant access* gives that agent exactly that; *No* adds nothing.
2. **Keys, when a device needs one.** The agent calls `request_device_key` and you get a second card: paste the
   API key or token (Home Assistant's long-lived token, a TrueNAS API key, `user:password` for Basic auth), or for
   SSH tap *Make a key*, add the public key it shows to the device's authorized keys, then *Done, I added it* (or
   paste a private key of your own without a passphrase). The value goes straight to the LAN gateway, encrypted
   there, and is added to the agent's requests on the way out. Agents never see it, and nothing shows it again.
3. **Taking it back:** the agent's details → *What it can reach* → *On your network* lists its devices, with
   *Describe*, *Remove* and, for ssh, *Trust new host key* (after you reset a device).

The agent reaches a device from its commands, `lan curl -s http://192.168.1.50:8123/api/states`, and each of those
commands still needs your OK unless a rule allows it. Always `http://`, even for a device on https: the gateway does
the https and adds the key. Read-only is GET only; full access also allows changes, tunnels and ssh. Agents see what
they have with `network_access`; `agents lan` lists every device and who may reach it.

**In an agent's browser** (agents with the browser: every device granted to them): it opens `http://IP:PORT/`
(a router's admin page, for example), with no OK per page, while its commands still ask. Signing in with a form
needs full access; the agent asks for the values with `request_login` like any site. Each browser reaches only its
own agent's devices, through the gateway, which logs every request.

**SSH**: an agent with full access runs `lan-ssh router nvram get productid`; the gateway signs in with the key it
keeps and sends back only the output, and that command still waits for your OK unless a rule allows it. The
device's host key is trusted the first time and checked after that. Every ssh command is in
`docker logs claude-agents-lan`. A "starts with" rule such as `lan-ssh router nvram get` only matches when plain
words follow it, so `nvram get 'x; reboot'` still asks you.

**sudo**: save the user's password in the vault as a login for that device (site `http://IP:22`) and grant it to
the agent; `lan-ssh --sudo PI_PASSWORD pi apt-get update` then runs the command with sudo there. The gateway types
the password into sudo's prompt, once and only when sudo asks, so the agent never sees it. It works with a key or a
vault password for signing in (`-l admin --login PI_PASSWORD --sudo PI_PASSWORD …`). The real root password (`su`)
isn't supported: if root may sign in over ssh, use `-l root --login ROOT_PASSWORD` instead.

How it's fenced: only the LAN gateway (`claude-agents-lan`) may leave for your network, and the firewall opens
it to exactly the IP:port pairs granted to some agent (within seconds of a change, closed again when you take a
grant away). The sandbox and the app can't reach them directly. Each command that may use the network gets a
token for its agent that dies when the command ends, so one agent can't use another's devices. Every request
through it is in `docker logs claude-agents-lan`. Device keys live in `DATA_DIR/lan` with their key file
(`lan.key`): keep that folder out of shared backups, like `DATA_DIR/vault`.

Not covered yet: fixing things on a host directly, beyond what one ssh command does. That's meant for a small runner
on each host that runs only approved commands, still to come.

## Good to know

- Use the chat on your home network or through a VPN. Don't expose it to the internet (only `/hooks/`
  if you use [webhooks](#webhooks)).
- Agents can't reach your LAN and only see their own folder. Claude agents get a shell only if you
  grant Bash; OpenAI agents run sandboxed commands (see [Use your ChatGPT plan](#use-your-chatgpt-plan)).
  To let an agent reach a device, ask it in the chat ([Home network](#home-network)).
  `FIREWALL_ALLOW=192.168.1.50:8123` is only for connectors in `config/mcp-servers.mjs` (e.g. a Home Assistant
  MCP server), and isn't per agent: any agent with WebFetch or Bash, or on an OpenAI model, could reach it too.
  WebFetch itself never opens addresses on your network.
- Agents and MCP servers are configured in `DATA_DIR/config/` (created on first start).
  A variable an MCP server needs (like `HA_TOKEN`) must also be listed in `compose.yaml`.
- Browser logins: use passwords unique to those sites, and no 2FA seeds (the agent asks you for codes).
- Two installs on one host: give each its own `AGENTS_SUBNET` and `UI_PORT`, and its own container
  names. Each install's firewall rules are named after its subnet, so they don't overwrite each other.
- Logs: `docker logs -f claude-agents`. Check the safeguards: `sudo bash scripts/verify.sh`.
  Each run also keeps its raw log in `DATA_DIR/agents/logs/<agent>/`. Those files and the Activity log
  are kept until you purge them (see Activity above); chats and runs stay in the database.
  An agent you gave **Bash** on a Claude model runs commands as the app's user, so the fence around the
  log files and the database is not enforced by the system for it (OpenAI models run commands in a
  sandbox that hides both). Grant Bash only to agents you'd trust with the server's data.
- The command sandbox has what the app's image has (sh, node, npm, curl, jq, dig, ping, nc, ssh) and no way
  to install system packages. All agents' workspace folders are mounted in it, so an approved command can read
  another agent's files. It can't reach other machines itself: only through the LAN gateway, to devices you granted.
- Changing `UI_PASSWORD` signs every browser out, and **Sign out** ends that session on the server too.

## License

[MIT](LICENSE) © Filipe Amorim. Free to use, modify and share, as long as the copyright notice is kept.
