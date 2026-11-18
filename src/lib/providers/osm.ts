import { createPromiseCache } from "@/lib/api/cache";
import { fetchJson, UpstreamError, USER_AGENT } from "@/lib/api/http";
import {
  distanceToPolygonXY,
  localFrame,
  normalizeRing,
  projectPolygon,
  type GeoPolygon,
  type Position,
} from "@/lib/geo/geometry";

/**
 * Huellas de edificios desde OpenStreetMap (Overpass API) y geocodificación (Nominatim).
 * Datos © colaboradores de OpenStreetMap, licencia ODbL: hay que mostrar la atribución.
 *
 * Políticas de uso: ambos servicios públicos son para uso moderado. Para volumen
 * alto, levantar una instancia propia de Overpass/Nominatim y apuntar
 * OVERPASS_URL / NOMINATIM_URL a ella.
 */

/**
 * Servidores Overpass en orden de preferencia (OVERPASS_URLS, separados por comas).
 * Los servidores públicos a veces se saturan o bloquean IPs de nube: se prueba el siguiente.
 */
const OVERPASS_URLS = (
  process.env.OVERPASS_URLS ??
  process.env.OVERPASS_URL ??
  "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://overpass.kumi.systems/api/interpreter"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";

export interface OsmBuilding {
  osmId: string;
  polygon: GeoPolygon;
  tags: Record<string, string>;
}

interface OverpassElement {
  type: "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

function toRing(geometry: { lat: number; lon: number }[]): Position[] | null {
  if (geometry.length < 4) return null;
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  if (first.lat !== last.lat || first.lon !== last.lon) return null;
  return normalizeRing(geometry.map((g) => [g.lon, g.lat] as Position));
}

function parseElements(elements: OverpassElement[]): OsmBuilding[] {
  const out: OsmBuilding[] = [];
  for (const el of elements) {
    if (!el.tags?.building) continue;
    let outer: Position[] | null = null;
    const holes: Position[][] = [];
    if (el.type === "way" && el.geometry) {
      outer = toRing(el.geometry);
    } else if (el.type === "relation" && el.members) {
      // Multipolígono: usamos el anillo exterior cerrado más grande y sus huecos cerrados.
      let bestArea = 0;
      for (const m of el.members) {
        if (m.type !== "way" || !m.geometry) continue;
        const ring = toRing(m.geometry);
        if (!ring) continue;
        if (m.role === "inner") {
          holes.push(ring);
          continue;
        }
        const area = projectPolygon({ type: "Polygon", coordinates: [ring] }).areaM2;
        if (area > bestArea) {
          bestArea = area;
          outer = ring;
        }
      }
    }
    if (!outer || outer.length < 4) continue;
    out.push({
      osmId: `${el.type}/${el.id}`,
      polygon: { type: "Polygon", coordinates: [outer, ...holes] },
      tags: el.tags,
    });
  }
  return out;
}

async function overpass(query: string): Promise<OverpassElement[]> {
  const body = new URLSearchParams({ data: query }).toString();
  let lastError: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const data = await fetchJson<{ elements?: OverpassElement[] }>("overpass", url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        timeoutMs: 15_000,
      });
      return data.elements ?? [];
    } catch (err) {
      lastError = err;
      // Una consulta mal formada (400) fallaría igual en otro servidor.
      if (err instanceof UpstreamError && err.status === 400) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new UpstreamError("overpass", "ningún servidor respondió");
}

const pointCache = createPromiseCache<{ buildings: OsmBuilding[] }>({ max: 2_000, ttlMs: 24 * 3600 * 1000 });
const bboxCache = createPromiseCache<{ buildings: OsmBuilding[] }>({ max: 200, ttlMs: 6 * 3600 * 1000 });

export interface BuildingMatch {
  building: OsmBuilding;
  containsPoint: boolean;
  distanceM: number;
}

/** Edificio que contiene el punto, o el más cercano dentro de `radiusM`. */
export async function findBuildingAt(lat: number, lng: number, radiusM = 30): Promise<BuildingMatch | null> {
  const key = `${lat.toFixed(5)}:${lng.toFixed(5)}:${radiusM}`;
  const { buildings } = await pointCache.get(key, async () => {
    const q = `[out:json][timeout:20];(way["building"](around:${radiusM},${lat},${lng});relation["building"]["type"="multipolygon"](around:${radiusM},${lat},${lng}););out tags geom;`;
    return { buildings: parseElements(await overpass(q)) };
  });
  if (buildings.length === 0) return null;

  const frame = localFrame(lat, lng);
  const origin = { x: 0, y: 0 };
  let best: BuildingMatch | null = null;
  for (const b of buildings) {
    const rings = b.polygon.coordinates.map((r) => r.map(frame.toXY));
    const d = distanceToPolygonXY(origin, rings);
    if (!best || d < best.distanceM) best = { building: b, containsPoint: d === 0, distanceM: Math.round(d * 10) / 10 };
  }
  return best;
}

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export async function searchBuildings(bbox: Bbox): Promise<OsmBuilding[]> {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const key = [bbox.south, bbox.west, bbox.north, bbox.east].map((v) => v.toFixed(4)).join(":");
  const { buildings } = await bboxCache.get(key, async () => {
    const q = `[out:json][timeout:60][maxsize:268435456];(way["building"](${b});relation["building"]["type"="multipolygon"](${b}););out tags geom;`;
    return { buildings: parseElements(await overpass(q)) };
  });
  return buildings;
}

export interface GeocodeResult {
  displayName: string;
  location: { lat: number; lng: number };
  type: string;
  category: string;
  osmId: string | null;
  boundingBox: Bbox | null;
  address: Record<string, string>;
}

const geocodeCache = createPromiseCache<{ results: GeocodeResult[] }>({ max: 2_000, ttlMs: 7 * 24 * 3600 * 1000 });

interface NominatimItem {
  lat: string;
  lon: string;
  display_name: string;
  type?: string;
  category?: string;
  osm_type?: string;
  osm_id?: number;
  boundingbox?: [string, string, string, string];
  address?: Record<string, string>;
}

export async function geocode(query: string, countryCodes = "ec", limit = 5): Promise<GeocodeResult[]> {
  const key = `${countryCodes}:${limit}:${query.trim().toLowerCase()}`;
  const { results } = await geocodeCache.get(key, async () => {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: String(limit),
      ...(countryCodes ? { countrycodes: countryCodes } : {}),
    });
    const items = await fetchJson<NominatimItem[]>("nominatim", `${NOMINATIM_URL}/search?${params}`, {
      headers: { "user-agent": USER_AGENT, "accept-language": "es" },
      timeoutMs: 10_000,
    });
    return {
      results: items.map((it) => ({
        displayName: it.display_name,
        location: { lat: Number(it.lat), lng: Number(it.lon) },
        type: it.type ?? "",
        category: it.category ?? "",
        osmId: it.osm_type && it.osm_id ? `${it.osm_type}/${it.osm_id}` : null,
        boundingBox: it.boundingbox
          ? {
              south: Number(it.boundingbox[0]),
              north: Number(it.boundingbox[1]),
              west: Number(it.boundingbox[2]),
              east: Number(it.boundingbox[3]),
            }
          : null,
        address: it.address ?? {},
      })),
    };
  });
  return results;
}
