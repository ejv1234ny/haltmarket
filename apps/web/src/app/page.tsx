import { MarketCard } from '@/components/market-card';
import { Card, CardContent } from '@/components/ui/card';
import { listAllMarkets } from '@/lib/mocks/fixtures';
import { supabaseConfigured } from '@/lib/env';

export default function HomePage() {
  const markets = listAllMarkets();
  const open = markets.filter((m) => m.status === 'open');
  const locked = markets.filter((m) => m.status === 'locked');
  const resolved = markets.filter((m) => m.status === 'resolved' || m.status === 'refunded');

  return (
    <main className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight sm:text-4xl">Open halts</h1>
        <p className="text-sm text-neutral-400">
          Bet on the reopen price of NASDAQ LUDP halts. Markets close 90 seconds after halt time.
        </p>
        {!supabaseConfigured && (
          <Card className="mt-2 border-amber-700/40 bg-amber-950/20">
            <CardContent className="p-4 text-xs text-amber-200">
              Running on mocked data. Set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
              <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to wire real markets once Phase 3 ships.
            </CardContent>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Live · {open.length}</h2>
        {open.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-neutral-400">No active halts right now.</CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {open.map((m) => (
              <MarketCard key={m.id} market={m} />
            ))}
          </div>
        )}
      </section>

      {locked.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Awaiting reopen · {locked.length}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {locked.map((m) => (
              <MarketCard key={m.id} market={m} />
            ))}
          </div>
        </section>
      )}

      {resolved.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Recently settled</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {resolved.map((m) => (
              <MarketCard key={m.id} market={m} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
