"use client";

import dynamic from "next/dynamic";
import { Activity, useCallback, useMemo, useRef, useState, useTransition } from "react";
import {
  analyzeBuildingAction,
  geocodeAction,
  prospectAction,
  type BuildingView,
  type ProspectView,
} from "@/app/actions";
import type { MapBbox, MapLead } from "./solar-map";
import type { GeoPolygon } from "@/lib/geo/geometry";

// Leaflet solo funciona en el navegador y pesa: carga diferida (bundle-dynamic-imports).
const SolarMap = dynamic(() => import("./solar-map"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-stone-800" aria-label="Cargando mapa" />,
});

const QUITO: [number, number] = [-0.1807, -78.4678];
const MAX_PROSPECT_KM2 = 4;
const usd = new Intl.NumberFormat("es-EC", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 0 });
const dec1 = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 1 });
const MONTHS = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
// Valores por defecto estables: evitan romper la memoización de las capas del mapa (rerender-memo-with-default-value).
const EMPTY_LEADS: MapLead[] = [];
const EMPTY_PANELS: BuildingView["panels"] = [];

type Tab = "building" | "prospect";
type Category = "residencial" | "comercial" | "industrial";
type Focus = { lat: number; lng: number; zoom: number };

function bboxAreaKm2(b: MapBbox): number {
  const midLat = ((b.south + b.north) / 2) * (Math.PI / 180);
  return (b.north - b.south) * 111.32 * ((b.east - b.west) * 111.32 * Math.cos(midLat));
}

export default function Explorer() {
  const [tab, setTab] = useState<Tab>("building");
  const [building, setBuilding] = useState<BuildingView | null>(null);
  const [prospects, setProspects] = useState<ProspectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [isPending, startTransition] = useTransition();

  // Valores que solo se leen al hacer clic: inputs no controlados + refs, así escribir
  // en ellos no re-renderiza el mapa (rerender-defer-reads, rerender-use-ref-transient-values).
  const boundsRef = useRef<MapBbox | null>(null);
  const billRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const minAreaRef = useRef<HTMLInputElement>(null);
  const excludeResidentialRef = useRef<HTMLInputElement>(null);

  const onBoundsChange = useCallback((bbox: MapBbox) => {
    boundsRef.current = bbox;
  }, []);

  // Estable (sin dependencias): el mapa no vuelve a registrar sus eventos en cada render.
  const runAnalysis = useCallback((target: { location?: { lat: number; lng: number }; roof?: GeoPolygon }) => {
    setTab("building");
    setError(null);
    const bill = Number(billRef.current?.value);
    const tariffCategory = (categoryRef.current?.value ?? "comercial") as Category;
    startTransition(async () => {
      const res = await analyzeBuildingAction({ ...target, monthlyBillUsd: bill > 0 ? bill : undefined, tariffCategory });
      if (res.ok) setBuilding(res.data);
      else setError(res.error);
    });
  }, []);

  // Modo dibujo: el clic agrega una esquina en vez de analizar. La ref evita recrear el callback.
  const [draft, setDraft] = useState<[number, number][] | null>(null);
  const drawingRef = useRef(false);

  const onPick = useCallback(
    (lat: number, lng: number) => {
      if (drawingRef.current) {
        setDraft((d) => [...(d ?? []), [lat, lng]]);
        return;
      }
      runAnalysis({ location: { lat, lng } });
    },
    [runAnalysis],
  );

  function startDrawing() {
    drawingRef.current = true;
    setDraft([]);
    setTab("building");
    setError(null);
  }

  function cancelDrawing() {
    drawingRef.current = false;
    setDraft(null);
  }

  function undoPoint() {
    setDraft((d) => (d && d.length > 0 ? d.slice(0, -1) : d));
  }

  function finishDrawing() {
    if (!draft || draft.length < 3) {
      setError("Marca al menos 3 esquinas del techo.");
      return;
    }
    const ring = draft.map(([lat, lng]) => [lng, lat] as [number, number]);
    ring.push(ring[0]);
    drawingRef.current = false;
    setDraft(null);
    runAnalysis({ roof: { type: "Polygon", coordinates: [ring] } });
  }

  const goTo = useCallback((f: Focus) => {
    setError(null);
    setFocus(f);
  }, []);

  function searchArea() {
    const bbox = boundsRef.current;
    if (!bbox) return;
    const area = bboxAreaKm2(bbox);
    if (area > MAX_PROSPECT_KM2) {
      setError(`La vista cubre ${dec1.format(area)} km². Acerca el mapa a menos de ${MAX_PROSPECT_KM2} km².`);
      return;
    }
    setError(null);
    const minRoofAreaM2 = Math.max(50, Number(minAreaRef.current?.value) || 500);
    const excludeResidential = excludeResidentialRef.current?.checked ?? true;
    startTransition(async () => {
      const res = await prospectAction({ bbox, minRoofAreaM2, excludeResidential });
      if (res.ok) setProspects(res.data);
      else setError(res.error);
    });
  }

  async function downloadCsv() {
    if (!prospects) return;
    // El exportador solo se descarga cuando alguien lo usa (bundle-conditional).
    const { leadsToCsv } = await import("@/lib/services/leads-export");
    const blob = new Blob([`﻿${leadsToCsv(prospects.leads)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leads-solares.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Derivado de estado, sin efectos (rerender-derived-state-no-effect), y memoizado para
  // que la capa de leads del mapa no se recalcule en renders que no la afectan.
  const mapLeads = useMemo<MapLead[]>(
    () =>
      tab === "prospect" && prospects
        ? prospects.leads.map((l) => ({
            id: l.id,
            lat: l.center.lat,
            lng: l.center.lng,
            tier: l.tier,
            label: `${l.name ?? l.buildingType} · ${dec1.format(l.estimatedKwp)} kWp · ${l.leadScore} pts`,
          }))
        : EMPTY_LEADS,
    [tab, prospects],
  );

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[55vh_auto] lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-1">
      <div className="relative min-h-0">
        <SolarMap
          center={QUITO}
          footprint={building?.footprint?.coordinates ?? null}
          panels={building?.panels ?? EMPTY_PANELS}
          leads={mapLeads}
          focus={focus}
          draft={draft}
          onPick={onPick}
          onBoundsChange={onBoundsChange}
        />
        <AddressSearch onFound={goTo} onError={setError} />
        {draft ? (
          <div className="absolute inset-x-3 bottom-4 z-[1000] mx-auto flex max-w-md flex-wrap items-center justify-center gap-2 rounded-xl bg-stone-950/90 p-3 text-sm text-stone-100 shadow-lg">
            <span className="w-full text-center text-xs text-stone-300">
              Haz clic en cada esquina del techo · {draft.length} {draft.length === 1 ? "punto" : "puntos"}
            </span>
            <button onClick={undoPoint} disabled={draft.length === 0} className="rounded-md border border-stone-600 px-3 py-1.5 disabled:opacity-40">
              Deshacer
            </button>
            <button onClick={cancelDrawing} className="rounded-md border border-stone-600 px-3 py-1.5">
              Cancelar
            </button>
            <button
              onClick={finishDrawing}
              disabled={draft.length < 3}
              className="rounded-md bg-amber-400 px-3 py-1.5 font-semibold text-stone-950 disabled:opacity-40"
            >
              Analizar techo
            </button>
          </div>
        ) : null}
        {isPending ? (
          <div className="absolute bottom-4 left-1/2 z-[1000] -translate-x-1/2 rounded-full bg-stone-900/90 px-4 py-2 text-sm text-amber-200 shadow-lg">
            Analizando…
          </div>
        ) : null}
      </div>

      <aside className="flex min-h-0 flex-col border-stone-800 bg-stone-950 text-stone-100 lg:border-l">
        <div className="grid grid-cols-2 border-b border-stone-800 text-sm" role="tablist">
          <TabButton active={tab === "building"} onClick={() => setTab("building")}>
            Analizar techo
          </TabButton>
          <TabButton active={tab === "prospect"} onClick={() => setTab("prospect")}>
            Buscar clientes
          </TabButton>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {error ? <p className="rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-200">{error}</p> : null}

          {/* Activity conserva el estado y el DOM de la pestaña oculta (rendering-activity). */}
          <Activity mode={tab === "building" ? "visible" : "hidden"}>
            <div className="space-y-4">
              <fieldset className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-stone-400">Planilla mensual (USD)</span>
                  <input
                    ref={billRef}
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    placeholder="Opcional"
                    className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-stone-400">Tarifa</span>
                  <select ref={categoryRef} defaultValue="comercial" className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5">
                    <option value="residencial">Residencial</option>
                    <option value="comercial">Comercial</option>
                    <option value="industrial">Industrial</option>
                  </select>
                </label>
              </fieldset>
              <button
                onClick={draft ? cancelDrawing : startDrawing}
                className={
                  draft
                    ? "w-full rounded-lg border border-stone-600 px-4 py-2 text-sm"
                    : "w-full rounded-lg bg-amber-400 px-4 py-2 font-semibold text-stone-950"
                }
              >
                {draft ? "Cancelar dibujo" : "✏️ Dibujar techo en el mapa"}
              </button>
              {building ? (
                <BuildingPanel b={building} />
              ) : (
                <p className="text-sm text-stone-400">
                  Acerca el mapa a un techo y pulsa «Dibujar techo»: marca sus esquinas sobre la imagen satelital. Colocamos los
                  paneles y estimamos la producción con datos satelitales de irradiancia. También puedes hacer clic sobre un
                  edificio para buscarlo automáticamente en OpenStreetMap.
                </p>
              )}
            </div>
          </Activity>

          <Activity mode={tab === "prospect" ? "visible" : "hidden"}>
            <div className="space-y-4">
              <fieldset className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-stone-400">Techo mínimo (m²)</span>
                  <input
                    ref={minAreaRef}
                    type="number"
                    min={50}
                    step={50}
                    defaultValue={500}
                    className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5"
                  />
                </label>
                <label className="mt-6 flex items-center gap-2">
                  <input ref={excludeResidentialRef} type="checkbox" defaultChecked />
                  <span>Excluir viviendas</span>
                </label>
              </fieldset>
              <button
                onClick={searchArea}
                disabled={isPending}
                className="w-full rounded-lg bg-amber-400 px-4 py-2 font-semibold text-stone-950 disabled:opacity-60"
              >
                Buscar en esta vista del mapa
              </button>
              {prospects ? (
                <ProspectPanel p={prospects} onSelect={goTo} onDownload={downloadCsv} />
              ) : (
                <p className="text-sm text-stone-400">
                  Mueve el mapa a una zona comercial o industrial (máx. {MAX_PROSPECT_KM2} km²) y busca. Ordenamos los techos por
                  potencial, tipo de edificio y datos de contacto disponibles.
                </p>
              )}
            </div>
          </Activity>
        </div>
      </aside>
    </div>
  );
}

/** Buscador con estado propio: escribir no re-renderiza el resto de la página. */
function AddressSearch({ onFound, onError }: { onFound: (f: Focus) => void; onError: (msg: string) => void }) {
  const [address, setAddress] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await geocodeAction(address);
      if (!res.ok) onError(res.error);
      else if (!res.data) onError("No encontramos esa dirección en Ecuador.");
      else onFound({ lat: res.data.lat, lng: res.data.lng, zoom: 18 });
    });
  }

  return (
    <form onSubmit={submit} className="absolute left-14 right-16 top-3 z-[1000] flex gap-2 sm:right-auto sm:w-96">
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Buscar dirección o lugar en Ecuador"
        aria-label="Buscar dirección"
        className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white/95 px-3 py-2 text-sm text-stone-900 shadow"
      />
      <button disabled={isPending} className="rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-amber-300 shadow disabled:opacity-60">
        {isPending ? "…" : "Ir"}
      </button>
    </form>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={active ? "border-b-2 border-amber-400 py-3 font-semibold text-amber-300" : "py-3 text-stone-400 hover:text-stone-200"}
    >
      {children}
    </button>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-stone-800 bg-stone-900 p-3">
      <div className="text-xs text-stone-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-stone-50">{value}</div>
      {hint ? <div className="text-xs text-stone-500">{hint}</div> : null}
    </div>
  );
}

function MonthlyBars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <svg viewBox="0 0 240 90" className="w-full" role="img" aria-label="Producción mensual">
      {values.map((v, i) => {
        const h = (v / max) * 70;
        return (
          <g key={i}>
            <rect x={(i * 20 + 3).toFixed(1)} y={(75 - h).toFixed(1)} width="14" height={h.toFixed(1)} rx="2" fill="#f59e0b" />
            <text x={(i * 20 + 10).toFixed(1)} y="88" textAnchor="middle" fontSize="8" fill="#a8a29e">
              {MONTHS[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function BuildingPanel({ b }: { b: BuildingView }) {
  const rec = b.recommendation;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{b.osmName ?? "Techo seleccionado"}</h2>
        <p className="text-xs text-stone-400">
          {b.roofType === "flat" ? "Techo plano" : "Techo inclinado"} · {num.format(b.footprintAreaM2)} m² · fuente {b.source} ·
          irradiancia {b.irradiance} · calidad {b.quality}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Kpi label="Capacidad máxima" value={`${dec1.format(b.capacityKwp)} kWp`} hint={`${num.format(b.panelsCount)} paneles`} />
        <Kpi label="Producción anual" value={`${num.format(b.annualKwh)} kWh`} />
        <Kpi label="Rendimiento" value={`${num.format(b.specificYield)} kWh/kWp`} />
        <Kpi label="Horas sol pico" value={`${dec1.format(b.peakSunHours)} h/día`} hint={`${b.tiltDegrees}° · azimut ${num.format(b.azimuthDegrees)}°`} />
      </div>
      <MonthlyBars values={b.monthlyKwh} />
      {rec ? (
        <div className="space-y-2 rounded-lg border border-emerald-900 bg-emerald-950/40 p-3">
          <h3 className="text-sm font-semibold text-emerald-300">
            Sistema recomendado: {dec1.format(rec.capacityKwp)} kWp ({num.format(rec.panelsCount)} paneles)
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <Kpi label="Inversión" value={usd.format(rec.capexUsd)} />
            <Kpi label="Ahorro año 1" value={usd.format(rec.savingsYear1Usd)} />
            <Kpi label="Retorno" value={rec.paybackYears !== null ? `${dec1.format(rec.paybackYears)} años` : "—"} />
            <Kpi label="TIR" value={rec.irrPercent !== null ? `${dec1.format(rec.irrPercent)} %` : "—"} />
          </div>
          <p className="text-xs text-stone-400">
            Cubre {dec1.format(rec.billOffsetPercent)} % del consumo · VAN {usd.format(rec.npvUsd)} · evita{" "}
            {dec1.format(rec.co2TonnesPerYear)} t CO₂/año
          </p>
        </div>
      ) : (
        <p className="text-xs text-stone-500">Ingresa la planilla mensual para ver ahorro, retorno y TIR.</p>
      )}
      {b.warnings.length > 0 ? (
        <ul className="list-disc space-y-1 pl-4 text-xs text-amber-200/80">
          {b.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const TIER_CLASS = {
  A: "bg-green-600 text-white",
  B: "bg-amber-500 text-stone-950",
  C: "bg-stone-600 text-white",
} as const;

function ProspectPanel({
  p,
  onSelect,
  onDownload,
}: {
  p: ProspectView;
  onSelect: (f: Focus) => void;
  onDownload: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Kpi label="Edificios" value={num.format(p.summary.buildingsScanned)} />
        <Kpi label="Prospectos" value={num.format(p.summary.buildingsMatched)} />
        <Kpi label="Potencial" value={`${num.format(p.summary.totalEstimatedKwp)} kWp`} />
      </div>
      <div className="flex items-center justify-between text-xs text-stone-400">
        <span>
          A: {p.summary.tiers.A} · B: {p.summary.tiers.B} · C: {p.summary.tiers.C}
        </span>
        <button onClick={onDownload} className="rounded-md border border-stone-700 px-2 py-1 text-stone-200 hover:bg-stone-800">
          Descargar CSV
        </button>
      </div>
      <ol className="divide-y divide-stone-800 rounded-lg border border-stone-800">
        {p.leads.map((l) => (
          // content-visibility: el navegador omite el layout de las filas fuera de pantalla (rendering-content-visibility).
          <li key={l.id} className="[contain-intrinsic-size:auto_64px] [content-visibility:auto]">
            <button
              onClick={() => onSelect({ lat: l.center.lat, lng: l.center.lng, zoom: 19 })}
              className="flex w-full items-start gap-3 p-3 text-left hover:bg-stone-900"
            >
              <span className={`mt-0.5 rounded px-1.5 text-xs font-bold ${TIER_CLASS[l.tier]}`}>{l.tier}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{l.name ?? `Edificio ${l.buildingType}`}</span>
                <span className="block text-xs text-stone-400">
                  {num.format(l.footprintAreaM2)} m² · {dec1.format(l.estimatedKwp)} kWp · {usd.format(l.estimatedAnnualSavingsUsd)}/año
                </span>
              </span>
              <span className="text-sm font-semibold tabular-nums text-amber-300">{l.leadScore}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
