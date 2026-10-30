// MikrotikLover dashboard app: shows the server's alerts as notifications (Web Push) and opens the right page.
// Nothing is cached: the dashboard always shows live data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data ? e.data.text() : "Alert" }; }
  const url = typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/";
  e.waitUntil(self.registration.showNotification(d.title || "RADIUS server", {
    body: d.body || "", icon: "/static/icons/icon-192.png", badge: "/static/icons/badge-96.png",
    tag: d.tag || undefined, data: { url },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
