'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  vapidPublicKey: string | null;
}

function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

type State = 'loading' | 'unsupported' | 'denied' | 'off' | 'on' | 'pending';

/**
 * One-click push opt-in. Shows nothing when the browser doesn't support
 * push or when VAPID keys are absent (dev without the operator task done).
 *
 * On opt-in:
 *   1. Register /sw.js service worker.
 *   2. Ask browser for notification permission.
 *   3. Subscribe via PushManager with the server's VAPID public key.
 *   4. POST the subscription to /api/push/subscribe so the server can fan
 *      out on new markets.
 */
export function SubscribeButton({ vapidPublicKey }: Props) {
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    if (!vapidPublicKey) {
      setState('unsupported');
      return;
    }
    if (
      typeof window === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        setState(sub ? 'on' : 'off');
      } catch {
        setState('off');
      }
    })();
  }, [vapidPublicKey]);

  async function subscribe() {
    if (!vapidPublicKey) return;
    setState('pending');
    try {
      const reg =
        (await navigator.serviceWorker.getRegistration('/sw.js')) ??
        (await navigator.serviceWorker.register('/sw.js'));
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const json = sub.toJSON();
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          user_agent: navigator.userAgent,
        }),
      });
      if (!res.ok) {
        setState('off');
        return;
      }
      setState('on');
    } catch (e) {
      console.error('push subscribe failed', e);
      setState('off');
    }
  }

  async function unsubscribe() {
    setState('pending');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState('off');
    } catch {
      setState('off');
    }
  }

  if (state === 'loading' || state === 'unsupported') return null;

  if (state === 'denied') {
    return (
      <span className="text-xs text-neutral-500">
        Notifications blocked in browser settings.
      </span>
    );
  }

  if (state === 'on') {
    return (
      <Button size="sm" variant="outline" onClick={unsubscribe}>
        Disable halt alerts
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="primary"
      onClick={subscribe}
      disabled={state === 'pending'}
    >
      {state === 'pending' ? '…' : 'Enable halt alerts'}
    </Button>
  );
}
