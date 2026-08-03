import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** Headings and the wordmark only — see .font-display in globals.css. */
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
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
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <div className="aurora" aria-hidden="true" />

        <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-md">
          <SiteNav />
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
          {children}
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto w-full max-w-5xl px-6 py-8 text-xs text-muted">
            Music data from{" "}
            <a
              className="underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-accent"
              href="https://musicbrainz.org"
              target="_blank"
              rel="noreferrer"
            >
              MusicBrainz
            </a>{" "}
            and{" "}
            <a
              className="underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-accent"
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
