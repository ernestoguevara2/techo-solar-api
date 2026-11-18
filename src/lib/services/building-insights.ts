import { ApiError } from "@/lib/api/problem";
import { analyzeFinance, type FinanceResult } from "@/lib/finance/analysis";
import { TARIFFS_EC } from "@/lib/finance/tariffs-ec";
import { projectPolygon, dominantAngle, type GeoPolygon } from "@/lib/geo/geometry";
import { layoutPanels, type LayoutResult, type Mounting } from "@/lib/geo/layout";
import { googleBuildingInsights, googleSolarEnabled, type GoogleBuildingInsights } from "@/lib/providers/google-solar";
import { getSolarResource, type SolarResource } from "@/lib/providers/irradiance";
import { findBuildingAt, type BuildingMatch } from "@/lib/providers/osm";
import { resolvePanel, type PanelSpec } from "@/lib/solar/panels";
import { estimateProduction, type ProductionResult } from "@/lib/solar/production";
import type { BuildingInsightsInput, ConsumptionInput } from "@/lib/schemas";

/**
 * "Building insights": a partir de un punto o de un polígono devuelve el
 * potencial solar del techo (equivalente a Google Solar buildingInsights),
 * con distribución de paneles, producción mensual, configuraciones y,
 * opcionalmente, la recomendación de tamaño y el análisis financiero.
 */

const PITCHED_SHAPES = new Set([
  "gabled",
  "hipped",
  "half-hipped",
  "pyramidal",
  "gambrel",
  "mansard",
  "skillion",
  "saltbox",
  "side_hipped",
  "round",
  "dome",
]);

const MAX_ROOF_AREA_M2 = Number(process.env.MAX_ROOF_AREA_M2 ?? 200_000);
const MAX_PANELS = Number(process.env.MAX_PANELS ?? 20_000);

export interface RoofPlane {
  pitchDegrees: number;
  azimuthDegrees: number;
  weight: number;
}

export interface BuildingInsights {
  id: string;
  center: { lat: number; lng: number };
  footprint: GeoPolygon | null;
  source: {
    footprint: "user" | "openstreetmap" | "google-solar";
    osmId?: string;
    osmTags?: Record<string, string>;
    matchDistanceM?: number;
    irradiance: SolarResource["source"];
    irradianceAttempts: SolarResource["attempts"];
  };
  quality: "HIGH" | "MEDIUM" | "LOW";
  roof: {
    type: "flat" | "pitched";
    footprintAreaM2: number;
    roofAreaM2: number;
    perimeterM: number;
    planes: RoofPlane[];
  };
  layout: Omit<LayoutResult, "panels"> & { mounting: Mounting; setbackM: number };
  panel: PanelSpec;
  solarPotential: {
    maxArrayPanelsCount: number;
    maxCapacityKwp: number;
    maxArrayAreaM2: number;
    annualEnergyAcKwh: number;
    monthlyEnergyAcKwh: number[];
    specificYieldKwhPerKwp: number;
    annualPoaKwhM2: number;
    annualGhiKwhM2: number;
    peakSunHoursPerDay: number;
    performanceRatio: number;
    carbonOffsetKgPerYear: number;
    panelConfigs: { panelsCount: number; capacityKwp: number; yearlyEnergyAcKwh: number }[];
  };
  recommendation?: {
    targetOffsetPercent: number;
    annualConsumptionKwh: number;
    panelsCount: number;
    capacityKwp: number;
    annualEnergyAcKwh: number;
    limitedByRoof: boolean;
    financialAnalysis: FinanceResult;
  };
  panels?: LayoutResult["panels"];
  warnings: string[];
}

function inferRoof(
  tags: Record<string, string> | undefined,
  input: BuildingInsightsInput,
  footprint: GeoPolygon,
): { type: "flat" | "pitched"; pitch: number; planes: RoofPlane[] } {
  const shape = tags?.["roof:shape"];
  let type: "flat" | "pitched";
  if (input.roofType !== "auto") type = input.roofType;
  else if (shape && PITCHED_SHAPES.has(shape)) type = "pitched";
  // En Ecuador predominan las losas planas de hormigón, también en vivienda: plano por defecto.
  else type = "flat";

  if (type === "flat") return { type, pitch: 0, planes: [] };

  const tagAngle = Number(tags?.["roof:angle"]);
  const pitch = input.pitchDegrees ?? (Number.isFinite(tagAngle) && tagAngle > 0 && tagAngle < 70 ? tagAngle : 15);
  const tagDir = Number(tags?.["roof:direction"]);
  const single = input.roofAzimuthDegrees ?? (Number.isFinite(tagDir) ? tagDir : undefined);
  if (single !== undefined || shape === "skillion") {
    return { type, pitch, planes: [{ pitchDegrees: pitch, azimuthDegrees: single ?? 0, weight: 1 }] };
  }
  // Dos aguas con la cumbrera paralela al lado más largo: dos planos opuestos al 50 %.
  const angle = dominantAngle(projectPolygon(footprint).rings[0]);
  // Normal a la cumbrera: vector (−sin θ, cos θ) en coordenadas locales (x = este, y = norte).
  const facing = ((Math.atan2(-Math.sin(angle), Math.cos(angle)) * 180) / Math.PI + 360) % 360;
  return {
    type,
    pitch,
    planes: [
      { pitchDegrees: pitch, azimuthDegrees: Math.round(facing), weight: 0.5 },
      { pitchDegrees: pitch, azimuthDegrees: Math.round((facing + 180) % 360), weight: 0.5 },
    ],
  };
}

export function consumptionToMonthlyKwh(c: ConsumptionInput): number | number[] {
  if (c.monthlyKwh !== undefined) return c.monthlyKwh;
  const tariff = c.tariffUsdPerKwh ?? TARIFFS_EC[c.tariffCategory].energyUsdPerKwh;
  return Math.round(((c.monthlyBillUsd ?? 0) / tariff) * 10) / 10;
}

function annualOf(v: number | number[]): number {
  return Array.isArray(v) ? v.reduce((a, b) => a + b, 0) : v * 12;
}

function hashId(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `bld_${(h >>> 0).toString(36)}`;
}

function minQuality(...qs: ("HIGH" | "MEDIUM" | "LOW")[]): "HIGH" | "MEDIUM" | "LOW" {
  if (qs.includes("LOW")) return "LOW";
  if (qs.includes("MEDIUM")) return "MEDIUM";
  return "HIGH";
}

function fromGoogle(g: GoogleBuildingInsights, solar: SolarResource, input: BuildingInsightsInput): BuildingInsights | null {
  const sp = g.solarPotential;
  if (!sp?.maxArrayPanelsCount || !g.center) return null;
  const panel = resolvePanel({
    capacityWatts: sp.panelCapacityWatts,
    widthM: sp.panelWidthMeters,
    heightM: sp.panelHeightMeters,
  });
  const dcToAc = 0.85; // factor recomendado por Google para pasar de energía DC a AC
  const configs = (sp.solarPanelConfigs ?? []).map((c) => ({
    panelsCount: c.panelsCount,
    capacityKwp: Math.round(c.panelsCount * panel.capacityWatts) / 1000,
    yearlyEnergyAcKwh: Math.round(c.yearlyEnergyDcKwh * dcToAc),
  }));
  const max = configs[configs.length - 1];
  const kwp = (sp.maxArrayPanelsCount * panel.capacityWatts) / 1000;
  const annual = max?.yearlyEnergyAcKwh ?? 0;
  const step = Math.max(1, Math.floor(configs.length / input.panelConfigsCount));
  const segs = sp.roofSegmentStats ?? [];
  const totalArea = segs.reduce((s, r) => s + (r.stats?.areaMeters2 ?? 0), 0) || 1;
  return {
    id: hashId(`google:${g.name ?? `${g.center.latitude},${g.center.longitude}`}`),
    center: { lat: g.center.latitude, lng: g.center.longitude },
    footprint: null,
    source: {
      footprint: "google-solar",
      irradiance: solar.source,
      irradianceAttempts: solar.attempts,
    },
    quality: g.imageryQuality === "HIGH" ? "HIGH" : g.imageryQuality === "MEDIUM" ? "MEDIUM" : "LOW",
    roof: {
      type: segs.some((s) => (s.pitchDegrees ?? 0) > 5) ? "pitched" : "flat",
      footprintAreaM2: sp.wholeRoofStats?.groundAreaMeters2 ?? 0,
      roofAreaM2: sp.wholeRoofStats?.areaMeters2 ?? 0,
      perimeterM: 0,
      planes: segs.map((s) => ({
        pitchDegrees: s.pitchDegrees ?? 0,
        azimuthDegrees: s.azimuthDegrees ?? 0,
        weight: Math.round(((s.stats?.areaMeters2 ?? 0) / totalArea) * 1000) / 1000,
      })),
    },
    layout: {
      panelsCount: sp.maxArrayPanelsCount,
      capacityKwp: kwp,
      orientation: "portrait",
      azimuthDegrees: segs[0]?.azimuthDegrees ?? 0,
      tiltDegrees: segs[0]?.pitchDegrees ?? 0,
      rowPitchM: 0,
      rowGapM: 0,
      modulesAreaM2: sp.maxArrayAreaMeters2 ?? 0,
      roofAreaM2: sp.wholeRoofStats?.areaMeters2 ?? 0,
      groundCoverageRatio: 0,
      truncated: false,
      mounting: "flush",
      setbackM: 0,
    },
    panel,
    solarPotential: {
      maxArrayPanelsCount: sp.maxArrayPanelsCount,
      maxCapacityKwp: kwp,
      maxArrayAreaM2: sp.maxArrayAreaMeters2 ?? 0,
      annualEnergyAcKwh: annual,
      monthlyEnergyAcKwh: [],
      specificYieldKwhPerKwp: kwp > 0 ? Math.round((annual / kwp) * 10) / 10 : 0,
      annualPoaKwhM2: 0,
      annualGhiKwhM2: solar.annualGhiKwhM2,
      peakSunHoursPerDay: Math.round(((sp.maxSunshineHoursPerYear ?? 0) / 365) * 100) / 100,
      performanceRatio: 0,
      carbonOffsetKgPerYear: Math.round((annual / 1000) * (sp.carbonOffsetFactorKgPerMwh ?? 0)),
      panelConfigs: configs.filter((_, i) => i % step === step - 1 || i === configs.length - 1),
    },
    warnings: ["Datos de Google Solar API: la producción mensual y la distribución de paneles no están disponibles en este modo."],
  };
}

export async function computeBuildingInsights(input: BuildingInsightsInput): Promise<BuildingInsights> {
  const warnings: string[] = [];
  const center = input.location ?? (input.roof ? projectPolygon(input.roof).center : null);
  if (!center) throw new ApiError("validation-error", "Envía location o roof.");

  // Regla async-api-routes / async-parallel: arrancamos todo lo independiente a la vez.
  // El recurso solar no depende de la huella del edificio, así que no espera por ella.
  const solarPromise = getSolarResource(center.lat, center.lng, { preferred: input.irradianceSource });
  const useGoogle = !input.roof && input.source !== "openstreetmap" && googleSolarEnabled();
  const googlePromise: Promise<GoogleBuildingInsights | null> = useGoogle
    ? googleBuildingInsights(center.lat, center.lng).catch(() => null)
    : Promise.resolve(null);
  const osmPromise: Promise<BuildingMatch | null> =
    input.roof || input.source === "google"
      ? Promise.resolve(null)
      : findBuildingAt(center.lat, center.lng, input.searchRadiusM);
  // Evita "unhandled rejection" si devolvemos antes de esperar alguna promesa.
  solarPromise.catch(() => undefined);
  osmPromise.catch(() => undefined);

  if (useGoogle) {
    const google = await googlePromise;
    if (google) {
      const mapped = fromGoogle(google, await solarPromise, input);
      if (mapped) return mapped;
    } else if (input.source === "google") {
      throw new ApiError("not-found", "Google Solar API no tiene datos para este punto.");
    }
  }

  let footprint: GeoPolygon;
  let match: BuildingMatch | null = null;
  if (input.roof) {
    footprint = input.roof;
  } else {
    match = await osmPromise;
    if (!match) {
      throw new ApiError(
        "not-found",
        `No encontramos un edificio a menos de ${input.searchRadiusM} m en OpenStreetMap. Envía el contorno del techo en 'roof'.`,
      );
    }
    footprint = match.building.polygon;
    if (!match.containsPoint) {
      warnings.push(`El punto no cae dentro de un edificio; se usó el más cercano (a ${match.distanceM} m).`);
    }
  }

  const projected = projectPolygon(footprint);
  if (projected.areaM2 < 5) throw new ApiError("validation-error", "El techo mide menos de 5 m².");
  if (projected.areaM2 > MAX_ROOF_AREA_M2) {
    throw new ApiError("area-too-large", `El techo supera ${MAX_ROOF_AREA_M2.toLocaleString("es-EC")} m². Divídelo en sectores.`);
  }

  const tags = match?.building.tags;
  const roof = inferRoof(tags, input, footprint);
  const panel = resolvePanel(input.panel);
  const lo = input.layout ?? {};
  const mounting: Mounting = lo.mounting ?? (roof.type === "flat" ? "tilted_rack" : "flush");
  const tilt = lo.tiltDegrees ?? (roof.type === "flat" ? 10 : roof.pitch);
  const setback = lo.setbackM ?? (projected.areaM2 >= 1_000 ? 1 : 0.5);

  const layout = layoutPanels(footprint, {
    panel: { widthM: panel.widthM, heightM: panel.heightM, capacityWatts: panel.capacityWatts },
    orientation: lo.orientation ?? "auto",
    mounting,
    tiltDegrees: tilt,
    setbackM: setback,
    colGapM: lo.colGapM ?? 0.02,
    rowGapM: lo.rowGapM,
    azimuthDegrees: lo.azimuthDegrees ?? (roof.planes.length === 1 ? roof.planes[0].azimuthDegrees : undefined),
    latitude: center.lat,
    obstructions: lo.obstructions,
    obstructionBufferM: lo.obstructionBufferM ?? 0.5,
    designSunElevationDegrees: lo.designSunElevationDegrees ?? 25,
    maxPanels: MAX_PANELS,
    includeGeometry: input.includeLayout,
  });
  if (layout.truncated) warnings.push(`Se alcanzó el máximo de ${MAX_PANELS} paneles por solicitud.`);
  if (layout.panelsCount === 0) warnings.push("No caben paneles con el retiro configurado. Prueba con un setbackM menor.");

  const solar = await solarPromise;
  if (solar.quality === "low") {
    warnings.push("No respondió ningún proveedor de irradiancia: se usó una estimación de cielo despejado (baja confianza).");
  }

  const planes =
    roof.type === "flat"
      ? [{ tiltDegrees: tilt, azimuthDegrees: layout.azimuthDegrees, weight: 1 }]
      : roof.planes.map((p) => ({ tiltDegrees: p.pitchDegrees, azimuthDegrees: p.azimuthDegrees, weight: p.weight }));
  if (roof.type === "pitched" && roof.planes.length === 2) {
    warnings.push("Techo a dos aguas: la producción promedia ambas caídas. Envía 'roof' por cada agua para más precisión.");
  }

  // Producción para 1 kWp; luego se escala linealmente a cada configuración.
  const perKwp: ProductionResult = estimateProduction({
    latitude: center.lat,
    monthlyGhiDaily: solar.monthlyGhiKwhM2Day,
    monthlyTempC: solar.monthlyTempC,
    capacityKwp: 1,
    planes,
    tempCoefficientPctPerC: panel.tempCoefficientPctPerC,
    arrayType: mounting === "tilted_rack" ? "fixed_open_rack" : "fixed_roof_mount",
    systemLossesPercent: input.systemLossesPercent,
    years: 1,
  });

  const maxKwp = layout.capacityKwp;
  const specific = perKwp.specificYieldKwhPerKwp;
  const configsCount = Math.min(input.panelConfigsCount, Math.max(1, layout.panelsCount));
  const configCounts = [
    ...new Set(Array.from({ length: configsCount }, (_, i) => Math.max(1, Math.round((layout.panelsCount * (i + 1)) / configsCount)))),
  ];
  const kwpOf = (n: number) => Math.round(n * panel.capacityWatts) / 1000;
  const annualMax = specific * maxKwp;
  const emission = input.finance?.emissionFactorKgPerKwh ?? 0.3;

  const result: BuildingInsights = {
    id: hashId(match?.building.osmId ?? JSON.stringify(footprint.coordinates[0].slice(0, 8))),
    center: { lat: round(center.lat, 6), lng: round(center.lng, 6) },
    footprint,
    source: {
      footprint: input.roof ? "user" : "openstreetmap",
      ...(match ? { osmId: match.building.osmId, osmTags: match.building.tags, matchDistanceM: match.distanceM } : {}),
      irradiance: solar.source,
      irradianceAttempts: solar.attempts,
    },
    quality: minQuality(
      input.roof ? "HIGH" : "MEDIUM",
      solar.quality === "high" ? "HIGH" : solar.quality === "medium" ? "MEDIUM" : "LOW",
    ),
    roof: {
      type: roof.type,
      footprintAreaM2: round(projected.areaM2, 1),
      roofAreaM2: round(roof.type === "pitched" ? projected.areaM2 / Math.cos((roof.pitch * Math.PI) / 180) : projected.areaM2, 1),
      perimeterM: round(projected.perimeterM, 1),
      planes: roof.type === "flat" ? [{ pitchDegrees: 0, azimuthDegrees: 0, weight: 1 }] : roof.planes,
    },
    layout: { ...withoutPanels(layout), mounting, setbackM: setback },
    panel,
    solarPotential: {
      maxArrayPanelsCount: layout.panelsCount,
      maxCapacityKwp: maxKwp,
      maxArrayAreaM2: layout.modulesAreaM2,
      annualEnergyAcKwh: round(annualMax, 0),
      monthlyEnergyAcKwh: perKwp.monthlyAcKwh.map((v) => round(v * maxKwp, 1)),
      specificYieldKwhPerKwp: specific,
      annualPoaKwhM2: perKwp.annualPoaKwhM2,
      annualGhiKwhM2: solar.annualGhiKwhM2,
      peakSunHoursPerDay: round(perKwp.annualPoaKwhM2 / 365, 2),
      performanceRatio: perKwp.performanceRatio,
      carbonOffsetKgPerYear: round(annualMax * emission, 0),
      panelConfigs: configCounts.map((n) => ({
        panelsCount: n,
        capacityKwp: kwpOf(n),
        yearlyEnergyAcKwh: round(specific * kwpOf(n), 0),
      })),
    },
    warnings,
  };

  if (input.consumption && layout.panelsCount > 0) {
    const monthlyKwh = consumptionToMonthlyKwh(input.consumption);
    const annualConsumption = annualOf(monthlyKwh);
    const neededKwp = (annualConsumption * input.targetOffsetPercent) / 100 / Math.max(1, specific);
    const neededPanels = Math.max(1, Math.ceil((neededKwp * 1000) / panel.capacityWatts));
    const panelsCount = Math.min(layout.panelsCount, neededPanels);
    const kwp = kwpOf(panelsCount);
    const finance = analyzeFinance({
      capacityKwp: kwp,
      monthlyProductionKwh: perKwp.monthlyAcKwh.map((v) => v * kwp),
      monthlyConsumptionKwh: monthlyKwh,
      tariffCategory: input.consumption.tariffCategory,
      region: input.consumption.region,
      tariffUsdPerKwh: input.consumption.tariffUsdPerKwh,
      ...input.finance,
    });
    result.recommendation = {
      targetOffsetPercent: input.targetOffsetPercent,
      annualConsumptionKwh: round(annualConsumption, 0),
      panelsCount,
      capacityKwp: kwp,
      annualEnergyAcKwh: round(specific * kwp, 0),
      limitedByRoof: neededPanels > layout.panelsCount,
      financialAnalysis: finance,
    };
    if (neededPanels > layout.panelsCount) {
      warnings.push(
        `El techo cubre ~${Math.round((annualMax / annualConsumption) * 100)} % del consumo; se necesitarían ${neededPanels} paneles.`,
      );
    }
  }

  if (input.includeLayout && layout.panels) result.panels = layout.panels;
  return result;
}

function withoutPanels(layout: LayoutResult): Omit<LayoutResult, "panels"> {
  const { panels: _omit, ...rest } = layout;
  void _omit;
  return rest;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
