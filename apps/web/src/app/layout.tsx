import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ronin Rush',
  description: 'A live, provably fair duel: cash out before the oni lands the final blow. Play money only.',
};

export const viewport: Viewport = { themeColor: '#2a2018', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" translate="no">
      <head>
        <meta name="google" content="notranslate" />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
