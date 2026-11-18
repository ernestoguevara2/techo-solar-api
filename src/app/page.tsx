import Link from "next/link";
import Explorer from "@/components/explorer";

export default function Home() {
  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-stone-800 bg-stone-950 px-4 py-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="grid h-8 w-8 place-items-center rounded-md bg-amber-400 text-lg font-black text-stone-950">
            ☀
          </span>
          <div>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">Techo Solar API</h1>
            <p className="hidden text-xs text-stone-400 sm:block">Análisis solar de techos con imágenes satelitales · Ecuador</p>
          </div>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/docs" className="rounded-md border border-stone-700 px-3 py-1.5 hover:bg-stone-800">
            Documentación API
          </Link>
          <a
            href="/api/v1/openapi.json"
            className="hidden rounded-md px-3 py-1.5 text-stone-400 hover:text-stone-200 sm:inline"
          >
            OpenAPI
          </a>
        </nav>
      </header>
      <Explorer />
    </main>
  );
}
