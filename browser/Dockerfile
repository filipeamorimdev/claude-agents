# The agents' browser: the Playwright MCP server driving Debian's Chromium (security updates through
# Debian, rebuilt with every image build) instead of the Chrome for Testing build in Microsoft's image.
# The guard (app/browser/mcp-guard.mjs) comes from DATA_DIR/browsers/guard at run time, not from here,
# and starts /app/cli.js per agent with compose.yaml's options, which point Playwright at this Chromium.
# Xvfb gives each browser a screen of its own, so Chromium runs headed, as on a desktop, instead of headless;
# chromium-l10n carries its translations (pt-PT and the other --lang values).
FROM node:24-bookworm-slim

# Bump on purpose: the guard's tool filtering depends on this server's tool names.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium chromium-l10n xvfb xauth tini ca-certificates \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The published package only: cli.js and its pinned playwright dependency, no browser download
# (Playwright uses /usr/lib/chromium/chromium through --executable-path).
RUN npm pack --silent "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && tar -xzf playwright-mcp-*.tgz --strip-components=1 \
 && rm playwright-mcp-*.tgz \
 && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && /usr/lib/chromium/chromium --version

ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
USER node
WORKDIR /home/node
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "node", "/app/cli.js", "--headless", "--browser=chromium", "--no-sandbox", "--executable-path=/usr/lib/chromium/chromium"]
