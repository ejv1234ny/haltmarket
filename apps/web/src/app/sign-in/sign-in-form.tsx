'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { env, supabaseConfigured } from '@/lib/env';
import { getBrowserSupabase } from '@/lib/supabase/browser';

export function SignInForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const supabase = getBrowserSupabase();
      if (!supabase) {
        setError('Supabase is not configured in this environment.');
        return;
      }
      const { error: e } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback` },
      });
      if (e) setError(e.message);
      else setSent(true);
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setError('Supabase is not configured in this environment.');
      return;
    }
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback` },
    });
  }

  if (sent) {
    return (
      <p className="text-sm text-emerald-300" data-testid="magic-link-sent">
        Check your inbox — we just sent a magic link to {email}.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onMagicLink} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-neutral-400">Email</span>
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@haltmarket.dev"
            autoComplete="email"
            data-testid="email-input"
          />
        </label>
        <Button type="submit" variant="primary" size="lg" disabled={busy || !supabaseConfigured}>
          Send magic link
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-neutral-600">
        <Separator className="flex-1" />
        <span>or</span>
        <Separator className="flex-1" />
      </div>

      <Button variant="outline" onClick={onGoogle} disabled={!supabaseConfigured}>
        Continue with Google
      </Button>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {!supabaseConfigured && (
        <p className="text-xs text-amber-300">
          Supabase credentials are unset. You&apos;re browsing the app as a demo user —
          set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and the anon key to enable real sign-in.
        </p>
      )}
    </div>
  );
}
