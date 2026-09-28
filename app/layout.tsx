import type { Metadata } from "next";
import { Source_Serif_4, Public_Sans } from "next/font/google";
import "./globals.css";

// Serif editorial: para el nombre "Cortana" y las fechas, como el
// membrete de una carta. Sans humanista: para todo lo demás, legible
// y cálido sin caer en el look "producto de SaaS".
const serifEditorial = Source_Serif_4({
  variable: "--font-editorial",
  subsets: ["latin"],
  weight: ["500", "600"],
  style: ["normal", "italic"],
});

const sansHumanista = Public_Sans({
  variable: "--font-humanista",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Cortana",
  description: "Tu asistente personal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="es"
      className={`${serifEditorial.variable} ${sansHumanista.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
