// HaltPredict Push Notification Service Worker

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(
      data.title || '\u26A1 HaltPredict Alert',
      {
        body: data.body || 'New halt detected',
        icon: '/logo.png',
        badge: '/logo.png',
        tag: data.tag || 'halt-notification',
        renotify: true,
        requireInteraction: true,
        vibrate: [200, 100, 200],
        data: {
          url: data.url || 'https://haltpredict.com',
          halt_id: data.halt_id,
          symbol: data.symbol,
        },
        actions: [
          { action: 'predict', title: '\uD83C\uDFAF Predict Now' },
          { action: 'dismiss', title: 'Dismiss' },
        ],
      }
    )
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || 'https://haltpredict.com';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
