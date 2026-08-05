import type { Metadata } from "next";
import "./globals.css";
import "./operations.css";

export const metadata: Metadata = {
  title: "Alpaca Paper Operations",
  description: "Paper-only Alpaca operations, readiness, and evidence dashboard"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
