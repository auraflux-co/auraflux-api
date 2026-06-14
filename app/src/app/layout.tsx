import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Script from 'next/script';
import { ClerkProvider } from '@clerk/nextjs';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { PWARegister } from '@/components/pwa/pwa-register';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'AuraFlux — Content Operations Platform',
  description: 'Video content production at scale',
  manifest: '/manifest.json',
  appleWebApp: {
    capable:    true,
    statusBarStyle: 'black-translucent',
    title:      'AuraFlux',
  },
  icons: {
    apple: '/icons/icon-192.png',
    icon:  '/icons/icon-192.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* New Relic Browser agent — real user monitoring, Core Web Vitals, JS errors */}
        <Script src="/newrelic-browser.js" strategy="beforeInteractive" />
        {/* Google Analytics — inline so it appears in server-rendered HTML */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-MBS26S2W6E" />
        <script dangerouslySetInnerHTML={{ __html: `
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-MBS26S2W6E');
        ` }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ClerkProvider afterSignOutUrl="/sign-in">
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
            <PWARegister />
            {children}
            <Toaster />
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
