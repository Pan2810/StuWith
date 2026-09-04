import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SessionExpiryProvider } from './session-expiry-provider';

export const metadata: Metadata = {
  title: 'StuWith',
  description: 'Phòng học live, ẩn danh khi cần.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * The API is a separate process on a separate origin, so the base URL is
 * configured rather than assumed. `NEXT_PUBLIC_` because it is read in the
 * browser; it is an origin, not a secret.
 *
 * This is the ONE read of it in the app, and the claim is now true rather than
 * aspirational: it used to say so while `dang-nhap/page.tsx` read the variable
 * again for itself. `process.env` is inlined at build time so either place
 * "works", but two reads is two answers the moment one of them gains a fallback,
 * a trim or a normalisation the other does not. It goes down as a prop, and
 * `useApiBaseUrl()` is how a screen below asks for it.
 */
const API_BASE_URL = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? '';

/**
 * VI is the default locale (Epic 1 constraint); EN arrives with Story 1.6.
 *
 * This stays a SERVER component. `SessionExpiryProvider` carries its own
 * `'use client'`, which is what keeps the boundary at the provider rather than
 * dragging the whole layout — and every page under it — into the client bundle.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <SessionExpiryProvider apiBaseUrl={API_BASE_URL}>{children}</SessionExpiryProvider>
      </body>
    </html>
  );
}
