import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Techo Solar API · Análisis solar de techos en Ecuador",
  description:
    "API para instaladores: potencial solar por techo, distribución de paneles, producción, análisis financiero con tarifas de Ecuador, prospección de clientes y propuestas.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
