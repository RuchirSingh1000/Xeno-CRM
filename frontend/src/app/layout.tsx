import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";
import { ToastProvider } from "@/components/Toast";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AIThinkingProvider } from "@/components/AIThinking";
import { Copilot } from "@/components/Copilot";
import { NavHistoryProvider } from "@/components/NavHistory";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Retail Activation Console",
  description:
    "AI-native mini-CRM for retail brands — multi-source ingestion, consent-aware segmentation, and async campaign delivery.",
  icons: {
    icon: [
      {
        url:
          "data:image/svg+xml," +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8dff"/><stop offset="1" stop-color="#2D6FF7"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><text x="50%" y="55%" font-family="Inter,system-ui,sans-serif" font-size="18" font-weight="700" text-anchor="middle" dominant-baseline="middle" fill="#fff">R</text></svg>`
          ),
      },
    ],
  },
};

const themeInit = `
(function() {
  try {
    var t = localStorage.getItem('xeno_theme');
    if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    if (t === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body suppressHydrationWarning className="min-h-full">
        <ThemeProvider>
          <ToastProvider>
            <AIThinkingProvider>
              <NavHistoryProvider>
                <div className="flex min-h-screen">
                  <Sidebar />
                  <main className="flex-1 min-w-0">{children}</main>
                </div>
                <Copilot />
              </NavHistoryProvider>
            </AIThinkingProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
