import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Divergent — playlists built around music, not habits",
  description:
    "Build playlists around genres, styles and moods instead of the artists you already play, and get properly introduced to someone new.",
};

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
      <body className="min-h-full flex flex-col">
        <header className="border-b border-border">
          <nav className="mx-auto flex w-full max-w-5xl items-center gap-6 px-6 py-4">
            <Link href="/" className="font-semibold tracking-tight">
              Divergent
            </Link>
            <div className="flex gap-5 text-sm text-muted">
              <Link href="/builder" className="hover:text-foreground">
                Build by style
              </Link>
              <Link href="/introduce" className="hover:text-foreground">
                Introduce me
              </Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
          {children}
        </main>
        <footer className="border-t border-border">
          <div className="mx-auto w-full max-w-5xl px-6 py-6 text-xs text-muted">
            Music data from{" "}
            <a
              className="underline hover:text-foreground"
              href="https://musicbrainz.org"
              target="_blank"
              rel="noreferrer"
            >
              MusicBrainz
            </a>{" "}
            and{" "}
            <a
              className="underline hover:text-foreground"
              href="https://listenbrainz.org"
              target="_blank"
              rel="noreferrer"
            >
              ListenBrainz
            </a>
            .
          </div>
        </footer>
      </body>
    </html>
  );
}
