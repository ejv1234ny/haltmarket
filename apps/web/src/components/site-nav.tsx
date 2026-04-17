'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const links = [
  { href: '/', label: 'Markets' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/history', label: 'History' },
  { href: '/leaderboard', label: 'Leaderboard' },
];

export function SiteNav({ email }: { email: string | null }) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-neutral-900 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="font-mono text-base font-bold tracking-tight">
          haltmarket
        </Link>
        <nav className="hidden gap-1 sm:flex">
          {links.map((l) => {
            const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm text-neutral-400 transition hover:text-neutral-100',
                  active && 'bg-neutral-900 text-neutral-100',
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          {email ? (
            <>
              <span className="hidden text-xs text-neutral-500 sm:inline">{email}</span>
              <form action="/auth/sign-out" method="post">
                <button
                  type="submit"
                  className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900"
                >
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link
              href="/sign-in"
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-emerald-400"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-t border-neutral-900 px-2 py-2 sm:hidden">
        {links.map((l) => {
          const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm text-neutral-400 transition hover:text-neutral-100',
                active && 'bg-neutral-900 text-neutral-100',
              )}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
