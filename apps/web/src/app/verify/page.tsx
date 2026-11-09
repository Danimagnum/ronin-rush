import { Suspense } from 'react';
import { VerifyClient } from './VerifyClient';

export const metadata = { title: 'Verify a round · Ronin Rush' };

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyClient />
    </Suspense>
  );
}
