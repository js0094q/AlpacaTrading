import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alpaca Paper Dashboard",
  description: "Paper-only Alpaca research and execution monitor"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
