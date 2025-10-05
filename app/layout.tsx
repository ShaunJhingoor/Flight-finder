// app/layout.tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import React from "react"; // for React.ReactNode
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "CODA AI",
  description: "Upload a url and learn",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
