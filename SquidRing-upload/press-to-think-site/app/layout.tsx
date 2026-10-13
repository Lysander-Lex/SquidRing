import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Press to Think',
  description: 'Hold to ask. Double tap to hear. A tactile AI thought companion.',
  openGraph: { title: 'Press to Think', description: 'Hold to ask. Double tap to hear.', images: ['/og.png'] },
  twitter: { card: 'summary_large_image', title: 'Press to Think', description: 'Hold to ask. Double tap to hear.', images: ['/og.png'] },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN"><body>{children}</body></html>
  );
}
