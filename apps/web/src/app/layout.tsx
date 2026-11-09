import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ronin Rush',
  description: 'A live, provably fair duel: cash out before the oni lands the final blow. Play money only.',
};

export const viewport: Viewport = { themeColor: '#131a2c', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
