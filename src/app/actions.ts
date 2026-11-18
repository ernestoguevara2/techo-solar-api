"use server";

import { headers } from "next/headers";
import { ApiError } from "@/lib/api/problem";
import { UpstreamError } from "@/lib/api/http";
import { consume } from "@/lib/api/rate-limit";
import { buildingInsightsSchema, prospectingSchema } from "@/lib/schemas";
import { computeBuildingInsights } from "@/lib/services/building-insights";
import { prospect, type Lead } from "@/lib/services/prospecting";
import { geocode } from "@/lib/providers/osm";
import type { GeoPolygon, Position } from "@/lib/geo/geometry";

/**
 * Server Actions de la demo pública (página principal).
 *
 * Regla server-auth-actions del skill de Vercel: una Server Action es un
 * endpoint público más, así que se protege igual que la API: se puede apagar
 * con DEMO_ENABLED=false, valida la entrada con los mismos schemas y tiene
 * rate limit por IP. Solo devuelve los campos que la UI usa (server-serialization).
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function guard(cost: number): Promise<string | null> {
  if (process.env.DEMO_ENABLED === "false") return "La demo está desactivada en este servidor.";
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  const limit = Number(process.env.DEMO_RATE_LIMIT_PER_MINUTE ?? 20);
  const rl = consume(`demo:${ip}`, cost, limit);
  return rl.allowed ? null : `Demasiadas consultas. Espera ${rl.resetSeconds} s.`;
}

const PROVIDER_NAMES: Record<string, string> = {
  overpass: "OpenStreetMap (Overpass)",
  nominatim: "el buscador de direcciones",
  "google-solar": "Google Solar API",
};

function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    return err.problemType === "not-found"
      ? "No encontramos un edificio en ese punto en OpenStreetMap. Usa «Dibujar techo» para trazar el contorno."
      : err.message;
  }
  if (err instanceof UpstreamError) {
    if (err.provider === "overpass") {
      return "OpenStreetMap (Overpass) no respondió. Usa «Dibujar techo» para trazar el contorno sobre la imagen satelital.";
    }
    return `${PROVIDER_NAMES[err.provider] ?? err.provider} no respondió. Intenta de nuevo en unos segundos.`;
  }
  return "No se pudo completar el análisis. Intenta de nuevo en unos segundos.";
}

export interface BuildingView {
  center: { lat: number; lng: number };
  footprint: GeoPolygon | null;
  panels: Position[][][];
  source: string;
  irradiance: string;
  quality: string;
  roofType: string;
  footprintAreaM2: number;
  panelsCount: number;
  capacityKwp: number;
  annualKwh: number;
  monthlyKwh: number[];
  specificYield: number;
  peakSunHours: number;
  tiltDegrees: number;
  azimuthDegrees: number;
  osmName: string | null;
  recommendation: null | {
    panelsCount: number;
    capacityKwp: number;
    annualKwh: number;
    limitedByRoof: boolean;
    capexUsd: number;
    savingsYear1Usd: number;
    paybackYears: number | null;
    irrPercent: number | null;
    npvUsd: number;
    billOffsetPercent: number;
    co2TonnesPerYear: number;
  };
  warnings: string[];
}

export async function analyzeBuildingAction(input: {
  /** Punto clicado: se busca el edificio en OpenStreetMap. */
  location?: { lat: number; lng: number };
  /** Contorno dibujado por el usuario: no depende de OpenStreetMap. */
  roof?: GeoPolygon;
  monthlyBillUsd?: number;
  tariffCategory: "residencial" | "comercial" | "industrial";
}): Promise<ActionResult<BuildingView>> {
  const blocked = await guard(3);
  if (blocked) return { ok: false, error: blocked };

  const parsed = buildingInsightsSchema.safeParse({
    ...(input.roof ? { roof: input.roof } : { location: input.location }),
    includeLayout: true,
    consumption: input.monthlyBillUsd
      ? { monthlyBillUsd: input.monthlyBillUsd, tariffCategory: input.tariffCategory }
      : undefined,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };

  try {
    const r = await computeBuildingInsights(parsed.data);
    const rec = r.recommendation;
    const fin = rec?.financialAnalysis;
    return {
      ok: true,
      data: {
        center: r.center,
        footprint: r.footprint,
        panels: (r.panels?.features ?? []).map((f) => f.geometry.coordinates),
        source: r.source.footprint,
        irradiance: r.source.irradiance,
        quality: r.quality,
        roofType: r.roof.type,
        footprintAreaM2: r.roof.footprintAreaM2,
        panelsCount: r.solarPotential.maxArrayPanelsCount,
        capacityKwp: r.solarPotential.maxCapacityKwp,
        annualKwh: r.solarPotential.annualEnergyAcKwh,
        monthlyKwh: r.solarPotential.monthlyEnergyAcKwh,
        specificYield: r.solarPotential.specificYieldKwhPerKwp,
        peakSunHours: r.solarPotential.peakSunHoursPerDay,
        tiltDegrees: r.layout.tiltDegrees,
        azimuthDegrees: r.layout.azimuthDegrees,
        osmName: r.source.osmTags?.name ?? null,
        recommendation:
          rec && fin
            ? {
                panelsCount: rec.panelsCount,
                capacityKwp: rec.capacityKwp,
                annualKwh: rec.annualEnergyAcKwh,
                limitedByRoof: rec.limitedByRoof,
                capexUsd: fin.capexUsd,
                savingsYear1Usd: fin.firstYear.savingsUsd,
                paybackYears: fin.cash.simplePaybackYears,
                irrPercent: fin.cash.irrPercent,
                npvUsd: fin.cash.npvUsd,
                billOffsetPercent: fin.billOffsetPercent,
                co2TonnesPerYear: fin.environment.co2AvoidedTonnesPerYear,
              }
            : null,
        warnings: r.warnings,
      },
    };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}

export async function geocodeAction(query: string): Promise<ActionResult<{ lat: number; lng: number; label: string } | null>> {
  const blocked = await guard(1);
  if (blocked) return { ok: false, error: blocked };
  const q = query.trim();
  if (q.length < 3 || q.length > 200) return { ok: false, error: "Escribe una dirección más específica." };
  try {
    const [first] = await geocode(q, "ec", 1);
    return { ok: true, data: first ? { ...first.location, label: first.displayName } : null };
  } catch {
    return { ok: false, error: "El buscador de direcciones no respondió." };
  }
}

export interface ProspectView {
  areaKm2: number;
  specificYield: number;
  summary: { buildingsScanned: number; buildingsMatched: number; totalEstimatedKwp: number; tiers: { A: number; B: number; C: number } };
  leads: Lead[];
}

export async function prospectAction(input: {
  bbox: { south: number; west: number; north: number; east: number };
  minRoofAreaM2: number;
  excludeResidential: boolean;
}): Promise<ActionResult<ProspectView>> {
  const blocked = await guard(10);
  if (blocked) return { ok: false, error: blocked };

  const parsed = prospectingSchema.safeParse({ ...input, limit: 100 });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };

  try {
    const r = await prospect(parsed.data);
    return {
      ok: true,
      data: { areaKm2: r.area.areaKm2, specificYield: r.solar.specificYieldKwhPerKwp, summary: r.summary, leads: r.leads },
    };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}
