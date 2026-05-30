// ============================================================
//  STOCK PRO — Service Worker
//  หน้าที่: รับ Push Notification + Cache offline
// ============================================================

const CACHE_NAME = 'stockpro-v1';

// ── Install ──
self.addEventListener('install', e => {
  self.skipWaiting();
});

// ── Activate ──
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// ── Push Notification ──
self.addEventListener('push', e => {
  let data = { title: '📈 Stock Pro', body: 'มีการแจ้งเตือนใหม่', icon: '/icon-192.png', badge: '/icon-96.png' };
  try {
    if (e.data) {
      const d = e.data.json();
      data = { ...data, ...d };
    }
  } catch {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/icon-192.png',
      badge: data.badge || '/icon-96.png',
      tag: data.tag || 'stockpro',
      renotify: true,
      requireInteraction: data.important || false,
      data: { url: data.url || '/' }
    })
  );
});

// ── Notification Click ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
