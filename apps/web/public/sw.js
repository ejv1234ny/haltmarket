// haltmarket service worker — Web Push receiver.
//
// Registered by components/push/subscribe-button.tsx. Handles two events:
//   * `push`     — display a notification with the payload.
//   * `notificationclick` — focus existing tab or open /market/<id>.
//
// Payload shape from notify-halt edge function:
//   { title, body, market_id, symbol }

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'haltmarket', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'haltmarket';
  const options = {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.market_id || 'haltmarket-generic',
    data: {
      url: data.market_id ? `/market/${data.market_id}` : '/',
      symbol: data.symbol || null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clientsList) {
        if (client.url.endsWith(url) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
      return null;
    })(),
  );
});
