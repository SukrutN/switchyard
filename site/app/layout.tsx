import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import Motion from "./components/Motion";
import "./globals.css";

// The voice: tight grotesk for the claims, mono for the operator.
const ui = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

// The Pages URL the site is served from, the anchor for every
// absolute social URL. In CI builds Next applies the basePath itself,
// so give it the bare origin there; local builds get the full URL.
const SITE_ORIGIN = "https://sukrutn.github.io";
const PAGE_PATH = "/switchyard/";
const SITE_URL = SITE_ORIGIN + PAGE_PATH;

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.GITHUB_ACTIONS === "true" ? SITE_ORIGIN : SITE_URL,
  ),
  title: "switchyard: a Go message broker that never lies",
  description:
    "A Go message broker: pub/sub, durable streams, key-value state, a read-only console. One binary, one protocol file, receipts on durable writes, v1.0.0.",
  keywords: [
    "go",
    "message broker",
    "pub/sub",
    "durable streams",
    "key-value",
    "journal",
    "receipts",
  ],
  openGraph: {
    title: "switchyard: a Go message broker that never lies",
    description:
      "Protocol v1 is frozen: op numbers never move, families only append. Try it with go run ./cmd/switchyard.",
    url: SITE_URL,
    siteName: "switchyard",
    locale: "en_US",
    type: "website",
    images: [
      {
        // absolute on purpose:basePath must never sneak into social URLs
        url: SITE_URL + "opengraph-image",
        width: 1200,
        height: 628,
        alt: "switchyard: a Go message broker that never lies",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "switchyard: a Go message broker that never lies",
    description:
      "A Go message broker: pub/sub, durable streams, key-value state, a read-only console. One binary, one protocol file.",
    images: [SITE_URL + "opengraph-image"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`}>
      <body>
        {/* No JS → no IntersectionObserver, so nothing may stay lost. */}
        <noscript>
          <style>{`
            .reveal{opacity:1;transform:none}
            [data-anim="wipe"] .wl__t{opacity:1;animation:none}
            [data-anim="wipe"] .wl::after{display:none}
            .gauge__value .countup,.gauge__value>*{opacity:1;transform:none}
            .site-header::after{display:none}
          `}</style>
        </noscript>
        <Motion />
        {children}
      </body>
    </html>
  );
}
