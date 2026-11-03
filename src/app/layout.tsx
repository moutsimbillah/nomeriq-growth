import type { Metadata, Viewport } from "next";
import "@fontsource-variable/manrope";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Nomeriq Growth",
    template: "%s · Nomeriq Growth",
  },
  description:
    "Independent AI-assisted sales portal for finding and converting commercial trading-signal providers.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#11231a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
