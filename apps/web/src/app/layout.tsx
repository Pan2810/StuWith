import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'StuWith',
  description: 'Phòng học live, ẩn danh khi cần.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/** VI is the default locale (Epic 1 constraint); EN arrives with Story 1.6. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
