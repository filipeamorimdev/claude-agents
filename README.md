# claude-agents

Self-hosted Claude agents with a chat UI. Agents run on a schedule or when you message them,
and can propose new agents for you to approve.

## Requirements

- A 64-bit Linux server (NAS, Raspberry Pi 4/5, mini PC) with Docker and Docker Compose v2
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

The repo is private: accept the GitHub invite and sign in to GitHub on the server first (`gh auth login`).

```bash
git clone https://github.com/filipeamorimdev/claude-agents.git
cd claude-agents
sudo ./install.sh
```

Paste the token when asked. At the end the installer prints the chat address and password.

## 3. Use it

Open `http://<server-ip>:8090` and sign in.

- **Chat with an agent:** choose the model and effort under the message box. The agent remembers them.
- **Create an agent:** ask `agent-architect`, then approve its suggestion in **Approvals**.
- **Team:** shows what the agents do together.

## Update

```bash
cd claude-agents && git pull && sudo ./install.sh
```

## Uninstall

```bash
sudo ./install.sh --uninstall           # add --purge to also delete data and settings
```

## Good to know

- Use the chat on your home network or through a VPN. Don't expose it to the internet.
- Agents can't reach your LAN, can't use a shell, and only see their own folder.
- Logs: `docker logs -f claude-agents`. Check the safeguards: `sudo bash scripts/verify.sh`.
