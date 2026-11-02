// Service worker: shows the push notifications the server sends (notify.mjs), even with the chat closed.
// Tapping one opens the chat it's about; tapping "Confirm this device" also confirms the device.
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { d = { body: e.data?.text() }; }
  // Every push must show a notification: browsers (Safari especially) stop delivering to apps that don't.
  e.waitUntil(self.registration.showNotification(d.title || "Agents", {
    body: d.body || "", tag: d.tag, icon: "/icon-192.png", badge: "/icon-192.png", data: d,
  }));
});

async function openApp(url) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
  if (win) { await win.focus(); win.postMessage({ type: "open", url }); return; }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil((async () => {
    if (d.confirm) {
      // Signed-in browsers confirm right away; otherwise the chat shows where to type the code.
      await fetch(`/api/devices/${encodeURIComponent(d.confirm.device)}/verify`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: d.confirm.code }),
      }).catch(() => {});
    }
    await openApp(d.url || "/");
  })());
});

// The browser replaced the subscription (rare): tell the server, so this device keeps getting notifications.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription;
    const sub = e.newSubscription ?? (old && await self.registration.pushManager.subscribe(old.options));
    if (!sub) return;
    await fetch("/api/devices/renew", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old: old?.endpoint, subscription: sub.toJSON() }),
    });
  })());
});
