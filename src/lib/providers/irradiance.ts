import { createPromiseCache } from "@/lib/api/cache";
import { fetchJson, UpstreamError } from "@/lib/api/http";
import { clearSkyMonthlyGhi, DAYS_IN_MONTH } from "@/lib/solar/irradiance";

/**
 * Recurso solar (GHI mensual + temperatura) con cadena de proveedores y respaldo:
 *
 *  1. PVGIS-NSRDB (Comisión Europea, datos satelitales NSRDB, cubre América 60°N–20°S → todo Ecuador)
 *  2. NASA POWER (climatología satelital global, resolución ~0,5°)
 *  3. PVGIS-ERA5 (reanálisis global)
 *  4. Estimación de cielo despejado (sin red; baja confianza)
 *
 * El orden se configura con IRRADIANCE_PROVIDERS. Todos son gratuitos y sin API key.
 */

export type IrradianceSource = "pvgis-nsrdb" | "pvgis-era5" | "nasa-power" | "clear-sky";

export interface SolarResource {
  location: { lat: number; lng: number };
  elevationM: number | null;
  monthlyGhiKwhM2Day: number[];
  monthlyTempC: number[];
  annualGhiKwhM2: number;
  source: IrradianceSource;
  quality: "high" | "medium" | "low";
  attempts: { provider: IrradianceSource; ok: boolean; error?: string }[];
}

type ProviderResult = Omit<SolarResource, "attempts" | "annualGhiKwhM2" | "location">;

const PVGIS_BASE = process.env.PVGIS_BASE_URL ?? "https://re.jrc.ec.europa.eu/api";
const NASA_POWER_BASE = process.env.NASA_POWER_BASE_URL ?? "https://power.larc.nasa.gov/api";
const MONTH_KEYS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

interface PvgisMrResponse {
  inputs?: { location?: { elevation?: number } };
  outputs?: { monthly?: Record<string, number>[] };
}

async function fromPvgis(lat: number, lng: number, db: "PVGIS-NSRDB" | "PVGIS-ERA5"): Promise<ProviderResult> {
  const version = db === "PVGIS-NSRDB" ? "v5_2" : "v5_3";
  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lng.toFixed(4),
    horirrad: "1",
    avtemp: "1",
    raddatabase: db,
    outputformat: "json",
  });
  const data = await fetchJson<PvgisMrResponse>("pvgis", `${PVGIS_BASE}/${version}/MRcalc?${params}`, {
    timeoutMs: 12_000,
  });
  const rows = data.outputs?.monthly ?? [];
  if (rows.length === 0) throw new UpstreamError("pvgis", "respuesta sin datos mensuales");

  const ghiSum = new Array(12).fill(0);
  const tSum = new Array(12).fill(0);
  const count = new Array(12).fill(0);
  const tCount = new Array(12).fill(0);
  for (const row of rows) {
    const m = Number(row.month) - 1;
    const h = row["H(h)_m"];
    if (m < 0 || m > 11 || typeof h !== "number") continue;
    ghiSum[m] += h / DAYS_IN_MONTH[m];
    count[m] += 1;
    if (typeof row.T2m === "number") {
      tSum[m] += row.T2m;
      tCount[m] += 1;
    }
  }
  if (count.some((c) => c === 0)) throw new UpstreamError("pvgis", "faltan meses en la serie");
  return {
    elevationM: data.inputs?.location?.elevation ?? null,
    monthlyGhiKwhM2Day: ghiSum.map((s, m) => s / count[m]),
    monthlyTempC: tSum.map((s, m) => (tCount[m] ? s / tCount[m] : 20)),
    source: db === "PVGIS-NSRDB" ? "pvgis-nsrdb" : "pvgis-era5",
    quality: db === "PVGIS-NSRDB" ? "high" : "medium",
  };
}

interface NasaPowerResponse {
  geometry?: { coordinates?: number[] };
  properties?: { parameter?: Record<string, Record<string, number>> };
}

async function fromNasaPower(lat: number, lng: number): Promise<ProviderResult> {
  const params = new URLSearchParams({
    parameters: "ALLSKY_SFC_SW_DWN,T2M",
    community: "RE",
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    format: "JSON",
  });
  const data = await fetchJson<NasaPowerResponse>(
    "nasa-power",
    `${NASA_POWER_BASE}/temporal/climatology/point?${params}`,
    { timeoutMs: 15_000 },
  );
  const ghi = data.properties?.parameter?.ALLSKY_SFC_SW_DWN;
  const t2m = data.properties?.parameter?.T2M;
  if (!ghi) throw new UpstreamError("nasa-power", "respuesta sin ALLSKY_SFC_SW_DWN");
  const monthly = MONTH_KEYS.map((k) => ghi[k]);
  if (monthly.some((v) => typeof v !== "number" || v < 0)) {
    throw new UpstreamError("nasa-power", "valores faltantes (-999) en la climatología");
  }
  const elevation = data.geometry?.coordinates?.[2];
  return {
    elevationM: typeof elevation === "number" ? elevation : null,
    monthlyGhiKwhM2Day: monthly,
    monthlyTempC: MONTH_KEYS.map((k) => (t2m && typeof t2m[k] === "number" && t2m[k] > -100 ? t2m[k] : 20)),
    source: "nasa-power",
    quality: "medium",
  };
}

function fromClearSky(lat: number): ProviderResult {
  const clearness = Number(process.env.CLEAR_SKY_CLEARNESS ?? 0.6);
  return {
    elevationM: null,
    monthlyGhiKwhM2Day: clearSkyMonthlyGhi(lat).map((v) => v * clearness),
    monthlyTempC: new Array(12).fill(20),
    source: "clear-sky",
    quality: "low",
  };
}

const cache = createPromiseCache<ProviderResult>({ max: 5_000, ttlMs: 30 * 24 * 3600 * 1000 });

function providerOrder(): IrradianceSource[] {
  const raw = process.env.IRRADIANCE_PROVIDERS ?? "pvgis-nsrdb,nasa-power,pvgis-era5,clear-sky";
  const valid: IrradianceSource[] = ["pvgis-nsrdb", "pvgis-era5", "nasa-power", "clear-sky"];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is IrradianceSource => (valid as string[]).includes(s));
  if (!list.includes("clear-sky")) list.push("clear-sky");
  return list;
}

function inNsrdbCoverage(lat: number, lng: number): boolean {
  return lat <= 60 && lat >= -20 && lng <= -20 && lng >= -180;
}

export async function getSolarResource(
  lat: number,
  lng: number,
  options: { preferred?: IrradianceSource } = {},
): Promise<SolarResource> {
  // Redondeo a ~1 km: la irradiancia no cambia a esa escala y mejora la tasa de aciertos de la caché.
  const rl = Math.round(lat * 100) / 100;
  const rg = Math.round(lng * 100) / 100;
  const order = providerOrder();
  if (options.preferred) {
    order.splice(order.indexOf(options.preferred), 1);
    order.unshift(options.preferred);
  }

  const attempts: SolarResource["attempts"] = [];
  for (const provider of order) {
    if (provider === "pvgis-nsrdb" && !inNsrdbCoverage(rl, rg)) continue;
    try {
      const result = await cache.get(`${provider}:${rl}:${rg}`, async () => {
        switch (provider) {
          case "pvgis-nsrdb":
            return fromPvgis(rl, rg, "PVGIS-NSRDB");
          case "pvgis-era5":
            return fromPvgis(rl, rg, "PVGIS-ERA5");
          case "nasa-power":
            return fromNasaPower(rl, rg);
          case "clear-sky":
            return fromClearSky(rl);
        }
      });
      attempts.push({ provider, ok: true });
      const monthly = result.monthlyGhiKwhM2Day.map((v) => Math.round(v * 1000) / 1000);
      return {
        ...result,
        location: { lat: rl, lng: rg },
        monthlyGhiKwhM2Day: monthly,
        monthlyTempC: result.monthlyTempC.map((v) => Math.round(v * 10) / 10),
        annualGhiKwhM2: Math.round(monthly.reduce((s, v, m) => s + v * DAYS_IN_MONTH[m], 0) * 10) / 10,
        attempts,
      };
    } catch (err) {
      attempts.push({ provider, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Inalcanzable: clear-sky nunca falla.
  throw new UpstreamError("irradiance", "ningún proveedor respondió");
}

/** Solo para tests. */
export function clearIrradianceCache(): void {
  cache.clear();
}
