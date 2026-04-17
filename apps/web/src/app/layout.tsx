import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SiteNav } from '@/components/site-nav';
import { getSessionUser } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'haltmarket',
  description: 'Real-money prediction market on NASDAQ LUDP halt reopen prices.',
  manifest: '/manifest.webmanifest',
  applicationName: 'haltmarket',
  appleWebApp: { capable: true, title: 'haltmarket', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <SiteNav email={user.email} />
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:py-10">{children}</div>
      </body>
    </html>
  );
}
