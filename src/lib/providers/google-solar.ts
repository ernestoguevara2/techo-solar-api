import { fetchJson } from "@/lib/api/http";

/**
 * Adaptador opcional para Google Solar API (buildingInsights:findClosest).
 *
 * Hoy Google no publica cobertura para Ecuador, pero sí para Perú, Colombia,
 * México y Brasil. Si se define GOOGLE_SOLAR_API_KEY, la API lo usa como fuente
 * preferida cuando hay datos y cae a OpenStreetMap cuando no.
 */

export function googleSolarEnabled(): boolean {
  return Boolean(process.env.GOOGLE_SOLAR_API_KEY);
}

interface LatLng {
  latitude: number;
  longitude: number;
}

export interface GoogleBuildingInsights {
  name?: string;
  center?: LatLng;
  boundingBox?: { sw: LatLng; ne: LatLng };
  imageryQuality?: "HIGH" | "MEDIUM" | "BASE";
  imageryDate?: { year: number; month: number; day: number };
  solarPotential?: {
    maxArrayPanelsCount?: number;
    maxArrayAreaMeters2?: number;
    maxSunshineHoursPerYear?: number;
    carbonOffsetFactorKgPerMwh?: number;
    panelCapacityWatts?: number;
    panelHeightMeters?: number;
    panelWidthMeters?: number;
    wholeRoofStats?: { areaMeters2?: number; groundAreaMeters2?: number };
    roofSegmentStats?: {
      pitchDegrees?: number;
      azimuthDegrees?: number;
      stats?: { areaMeters2?: number; groundAreaMeters2?: number; sunshineQuantiles?: number[] };
      center?: LatLng;
    }[];
    solarPanelConfigs?: { panelsCount: number; yearlyEnergyDcKwh: number }[];
  };
}

export async function googleBuildingInsights(lat: number, lng: number): Promise<GoogleBuildingInsights | null> {
  const key = process.env.GOOGLE_SOLAR_API_KEY;
  if (!key) return null;
  const params = new URLSearchParams({
    "location.latitude": lat.toFixed(6),
    "location.longitude": lng.toFixed(6),
    requiredQuality: "BASE",
  });
  try {
    return await fetchJson<GoogleBuildingInsights>(
      "google-solar",
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?${params}`,
      { headers: { "x-goog-api-key": key }, timeoutMs: 10_000 },
    );
  } catch (err) {
    // 404 = sin cobertura en ese punto: no es un error para nosotros.
    if (err instanceof Error && "status" in err && (err as { status?: number }).status === 404) return null;
    throw err;
  }
}
