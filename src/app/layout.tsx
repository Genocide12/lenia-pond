import type { Metadata } from "next";
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

const REPO_NAME = process.env.REPO_NAME || "lenia-aquarium";
const BASE = process.env.EXPORT_STATIC === "1" ? `/${REPO_NAME}` : "";

export const metadata: Metadata = {
  title: "Пруд Лении — живая математика в браузере",
  description:
    "Два живых мира: головастики, собирающиеся из хаоса, и грибы, делящиеся на колонию. Интерактивная реконструкция Лении Бёрта Чана. Понятно в любом возрасте.",
  keywords: ["Ления", "Lenia", "клеточные автоматы", "Game of Life", "искусственная жизнь", "ALife", "WebGL"],
  icons: {
    icon: `${BASE}/favicon.svg`,
  },
  openGraph: {
    title: "Пруд Лении — живая математика в браузере",
    description: "Головастики рождаются из хаоса, грибы делятся — живой мир по трём правилам",
    type: "website",
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
