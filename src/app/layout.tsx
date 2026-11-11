import type { Metadata, Viewport } from "next";
import { Manrope, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "cyrillic"],
});

const REPO_NAME = process.env.REPO_NAME || "lenia-pond";
const BASE = process.env.EXPORT_STATIC === "1" ? `/${REPO_NAME}` : "";

export const viewport: Viewport = {
  themeColor: "#040806",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Пруд Лении",
  description:
    "Пруд из тысяч живых блюдцев: зум от одного блюдца до всей сетки, разные виды и климаты, деление и гибель от условий.",
  keywords: ["Ления", "Lenia", "клеточные автоматы", "Game of Life", "искусственная жизнь", "ALife", "WebGL"],
  manifest: `${BASE}/manifest.webmanifest`,
  icons: {
    icon: `${BASE}/favicon.svg`,
    apple: `${BASE}/apple-touch-icon.png`,
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Пруд Лении",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${manrope.variable} ${jetbrainsMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
