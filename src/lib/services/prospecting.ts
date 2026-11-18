import { ApiError } from "@/lib/api/problem";
import { TARIFFS_EC, GRID_EMISSION_FACTOR_KG_PER_KWH } from "@/lib/finance/tariffs-ec";
import { bboxAreaKm2, projectPolygon, type GeoPolygon } from "@/lib/geo/geometry";
import { autoRowGap } from "@/lib/geo/layout";
import { getSolarResource } from "@/lib/providers/irradiance";
import { searchBuildings, type Bbox, type OsmBuilding } from "@/lib/providers/osm";
import { resolvePanel } from "@/lib/solar/panels";
import { estimateProduction } from "@/lib/solar/production";
import type { ProspectingInput } from "@/lib/schemas";

export { leadsToCsv } from "./leads-export";

/**
 * Prospección / generación de leads: escanea una zona del mapa, encuentra los
 * techos con más potencial y los ordena por un puntaje comercial.
 * Es el "generator" para las empresas instaladoras (similar a Planno para C&I).
 */

const MAX_AREA_KM2 = Number(process.env.MAX_PROSPECT_AREA_KM2 ?? 4);

const CI_TYPES = new Set([
  "industrial",
  "warehouse",
  "factory",
  "manufacture",
  "commercial",
  "retail",
  "supermarket",
  "office",
  "hangar",
  "hospital",
  "school",
  "university",
  "college",
  "public",
  "government",
  "civic",
  "sports_hall",
  "stadium",
  "parking",
  "roof",
  "farm_auxiliary",
  "greenhouse",
  "hotel",
  "transportation",
  "train_station",
]);
const RESIDENTIAL_TYPES = new Set(["residential", "house", "apartments", "detached", "terrace", "semidetached_house", "bungalow", "hut", "cabin"]);

export interface Lead {
  id: string;
  osmId: string;
  name: string | null;
  buildingType: string;
  segment: "comercial_industrial" | "residencial" | "otro";
  address: string | null;
  center: { lat: number; lng: number };
  footprintAreaM2: number;
  estimatedUsableAreaM2: number;
  estimatedPanels: number;
  estimatedKwp: number;
  estimatedAnnualKwh: number;
  estimatedAnnualSavingsUsd: number;
  estimatedCo2TonnesPerYear: number;
  roofShape: string | null;
  hasExistingSolar: boolean;
  leadScore: number;
  tier: "A" | "B" | "C";
  contact: { phone?: string; website?: string; email?: string; operator?: string; brand?: string };
  links: { openStreetMap: string; googleMaps: string };
  polygon?: GeoPolygon;
}

export interface ProspectingResult {
  area: { bbox: Bbox; areaKm2: number };
  solar: { specificYieldKwhPerKwp: number; source: string; annualGhiKwhM2: number };
  summary: {
    buildingsScanned: number;
    buildingsMatched: number;
    totalEstimatedKwp: number;
    totalEstimatedAnnualKwh: number;
    tiers: { A: number; B: number; C: number };
  };
  leads: Lead[];
  pagination: { limit: number; nextCursor: string | null; total: number };
  attribution: string;
}

function bboxFromCenter(lat: number, lng: number, radiusM: number): Bbox {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };
}

function hasSolar(tags: Record<string, string>): boolean {
  return (
    tags["generator:source"] === "solar" ||
    tags["roof:material"] === "solar_panels" ||
    tags["building:roof"] === "solar" ||
    tags["solar"] !== undefined
  );
}

function addressOf(tags: Record<string, string>): string | null {
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  const city = tags["addr:city"];
  const parts = [street && number ? `${street} ${number}` : street, city].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function scoreLead(kwp: number, buildingType: string, tags: Record<string, string>, existingSolar: boolean): number {
  const size = clamp01(Math.log10(Math.max(1, kwp)) / Math.log10(500));
  const typeScore = CI_TYPES.has(buildingType) ? 1 : RESIDENTIAL_TYPES.has(buildingType) ? 0.25 : 0.55;
  const shape = tags["roof:shape"];
  const flatScore = !shape || shape === "flat" ? 1 : 0.6;
  const contact = tags.name || tags.brand || tags.operator ? 0.6 : 0;
  const contactScore = clamp01(contact + (tags.phone || tags["contact:phone"] || tags.website || tags["contact:website"] ? 0.4 : 0));
  let score = 0.45 * size + 0.25 * typeScore + 0.15 * flatScore + 0.15 * contactScore;
  if (existingSolar) score *= 0.3;
  return Math.round(score * 100);
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^o:(\d+)$/.exec(raw);
  if (!match) throw new ApiError("validation-error", "El cursor no es válido.");
  return Number(match[1]);
}

export async function prospect(input: ProspectingInput): Promise<ProspectingResult> {
  const bbox: Bbox =
    input.bbox ?? bboxFromCenter(input.center!.lat, input.center!.lng, input.radiusM!);
  const areaKm2 = bboxAreaKm2(bbox);
  // Validación barata antes de cualquier llamada externa.
  if (areaKm2 > MAX_AREA_KM2) {
    throw new ApiError("area-too-large", `El área es de ${areaKm2.toFixed(2)} km²; el máximo es ${MAX_AREA_KM2} km² por búsqueda.`, {
      extensions: { areaKm2: Math.round(areaKm2 * 100) / 100, maxAreaKm2: MAX_AREA_KM2 },
    });
  }
  const offset = decodeCursor(input.cursor);
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLng = (bbox.west + bbox.east) / 2;

  // Overpass y el recurso solar son independientes: en paralelo (regla async-parallel).
  const [buildings, solar] = await Promise.all([searchBuildings(bbox), getSolarResource(centerLat, centerLng)]);

  const panel = resolvePanel(input.panel);
  const tilt = 10;
  const perKwp = estimateProduction({
    latitude: centerLat,
    monthlyGhiDaily: solar.monthlyGhiKwhM2Day,
    monthlyTempC: solar.monthlyTempC,
    capacityKwp: 1,
    planes: [{ tiltDegrees: tilt, azimuthDegrees: centerLat >= 0 ? 180 : 0 }],
    tempCoefficientPctPerC: panel.tempCoefficientPctPerC,
    arrayType: "fixed_open_rack",
    years: 1,
  });
  const specific = perKwp.specificYieldKwhPerKwp;

  // Densidad de paneles en techo plano con estructura a 10°, en orientación vertical.
  const depth = panel.heightM * Math.cos((tilt * Math.PI) / 180);
  const pitch = depth + autoRowGap(panel.heightM, tilt, "tilted_rack", 25);
  const panelsPerM2 = 1 / ((panel.widthM + 0.02) * pitch);
  const typeFilter = input.buildingTypes?.length ? new Set(input.buildingTypes) : null;

  const leads: Lead[] = [];
  for (const b of buildings) {
    const lead = toLead(b, {
      minArea: input.minRoofAreaM2,
      typeFilter,
      excludeResidential: input.excludeResidential,
      excludeExistingSolar: input.excludeExistingSolar,
      panelsPerM2,
      panelWatts: panel.capacityWatts,
      specific,
      tariff: input.tariffUsdPerKwh,
      includeGeometry: input.includeGeometry,
    });
    if (lead) leads.push(lead);
  }

  const sorters: Record<ProspectingInput["sortBy"], (a: Lead, b: Lead) => number> = {
    score: (a, b) => b.leadScore - a.leadScore || b.estimatedKwp - a.estimatedKwp,
    area: (a, b) => b.footprintAreaM2 - a.footprintAreaM2,
    kwp: (a, b) => b.estimatedKwp - a.estimatedKwp,
  };
  const sorted = leads.toSorted(sorters[input.sortBy]);
  const page = sorted.slice(offset, offset + input.limit);
  const tiers = { A: 0, B: 0, C: 0 };
  let totalKwp = 0;
  let totalKwh = 0;
  for (const l of sorted) {
    tiers[l.tier] += 1;
    totalKwp += l.estimatedKwp;
    totalKwh += l.estimatedAnnualKwh;
  }

  return {
    area: { bbox, areaKm2: Math.round(areaKm2 * 1000) / 1000 },
    solar: { specificYieldKwhPerKwp: specific, source: solar.source, annualGhiKwhM2: solar.annualGhiKwhM2 },
    summary: {
      buildingsScanned: buildings.length,
      buildingsMatched: sorted.length,
      totalEstimatedKwp: Math.round(totalKwp),
      totalEstimatedAnnualKwh: Math.round(totalKwh),
      tiers,
    },
    leads: page,
    pagination: {
      limit: input.limit,
      nextCursor: offset + input.limit < sorted.length ? encodeCursor(offset + input.limit) : null,
      total: sorted.length,
    },
    attribution: "Huellas de edificios © colaboradores de OpenStreetMap (ODbL)",
  };
}

function toLead(
  b: OsmBuilding,
  o: {
    minArea: number;
    typeFilter: Set<string> | null;
    excludeResidential: boolean;
    excludeExistingSolar: boolean;
    panelsPerM2: number;
    panelWatts: number;
    specific: number;
    tariff?: number;
    includeGeometry: boolean;
  },
): Lead | null {
  const type = b.tags.building ?? "yes";
  // Filtros baratos primero (regla js-early-exit).
  if (o.typeFilter && !o.typeFilter.has(type)) return null;
  const residential = RESIDENTIAL_TYPES.has(type);
  if (o.excludeResidential && residential) return null;
  const existingSolar = hasSolar(b.tags);
  if (o.excludeExistingSolar && existingSolar) return null;

  const projected = projectPolygon(b.polygon);
  if (projected.areaM2 < o.minArea) return null;

  const setback = projected.areaM2 >= 1_000 ? 1 : 0.5;
  // Área útil aproximada: descontar el retiro perimetral y un 10 % por equipos/obstrucciones.
  const usable = Math.max(0, projected.areaM2 - projected.perimeterM * setback) * 0.9;
  const panels = Math.floor(usable * o.panelsPerM2);
  if (panels <= 0) return null;
  const kwp = (panels * o.panelWatts) / 1000;
  const annual = kwp * o.specific;
  const segment = CI_TYPES.has(type) ? "comercial_industrial" : residential ? "residencial" : "otro";
  const tariff = o.tariff ?? TARIFFS_EC[segment === "residencial" ? "residencial" : "comercial"].energyUsdPerKwh;
  const score = scoreLead(kwp, type, b.tags, existingSolar);
  const center = projected.center;

  return {
    id: `lead_${b.osmId.replace("/", "_")}`,
    osmId: b.osmId,
    name: b.tags.name ?? b.tags.brand ?? null,
    buildingType: type,
    segment,
    address: addressOf(b.tags),
    center: { lat: Math.round(center.lat * 1e6) / 1e6, lng: Math.round(center.lng * 1e6) / 1e6 },
    footprintAreaM2: Math.round(projected.areaM2),
    estimatedUsableAreaM2: Math.round(usable),
    estimatedPanels: panels,
    estimatedKwp: Math.round(kwp * 10) / 10,
    estimatedAnnualKwh: Math.round(annual),
    estimatedAnnualSavingsUsd: Math.round(annual * tariff),
    estimatedCo2TonnesPerYear: Math.round(annual * GRID_EMISSION_FACTOR_KG_PER_KWH) / 1000,
    roofShape: b.tags["roof:shape"] ?? null,
    hasExistingSolar: existingSolar,
    leadScore: score,
    tier: score >= 70 ? "A" : score >= 45 ? "B" : "C",
    contact: {
      ...(b.tags.phone || b.tags["contact:phone"] ? { phone: b.tags.phone ?? b.tags["contact:phone"] } : {}),
      ...(b.tags.website || b.tags["contact:website"] ? { website: b.tags.website ?? b.tags["contact:website"] } : {}),
      ...(b.tags.email || b.tags["contact:email"] ? { email: b.tags.email ?? b.tags["contact:email"] } : {}),
      ...(b.tags.operator ? { operator: b.tags.operator } : {}),
      ...(b.tags.brand ? { brand: b.tags.brand } : {}),
    },
    links: {
      openStreetMap: `https://www.openstreetmap.org/${b.osmId}`,
      googleMaps: `https://www.google.com/maps/search/?api=1&query=${center.lat.toFixed(6)},${center.lng.toFixed(6)}`,
    },
    ...(o.includeGeometry ? { polygon: b.polygon } : {}),
  };
}

export function leadsToGeoJson(result: ProspectingResult) {
  return {
    type: "FeatureCollection" as const,
    features: result.leads.map((l) => {
      const { polygon, ...props } = l;
      return {
        type: "Feature" as const,
        id: l.id,
        geometry: polygon ?? { type: "Point" as const, coordinates: [l.center.lng, l.center.lat] },
        properties: props,
      };
    }),
    summary: result.summary,
    pagination: result.pagination,
    attribution: result.attribution,
  };
}
