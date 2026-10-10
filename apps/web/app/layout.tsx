import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Al Hamza Electronics',
  description: 'The shop, from anywhere.',
};

/**
 * The owner opens this on a phone far more often than on a laptop, so the
 * layout starts narrow and the text is sized to be read at arm's length
 * without pinching.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
