import type { Metadata } from 'next';
import './globals.css';
import FirefoxInputGuard from '@/components/FirefoxInputGuard';

export const metadata: Metadata = {
  title: 'EV Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <FirefoxInputGuard />
        {children}
      </body>
    </html>
  );
}
