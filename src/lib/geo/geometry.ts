/**
 * Geometría plana para techos. Se proyecta cada polígono a metros locales
 * (equirectangular centrada en el polígono); a escala de un edificio el
 * error es despreciable (<0,1 %).
 *
 * Convención GeoJSON: las posiciones son [lng, lat].
 */

export type Position = [number, number];
export type Ring = Position[];
export interface GeoPolygon {
  type: "Polygon";
  coordinates: Ring[];
}

export interface XY {
  x: number;
  y: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export interface LocalFrame {
  origin: { lat: number; lng: number };
  toXY(p: Position): XY;
  toLngLat(p: XY): Position;
}

export function localFrame(lat0: number, lng0: number): LocalFrame {
  const kx = Math.cos(lat0 * DEG) * EARTH_RADIUS_M * DEG;
  const ky = EARTH_RADIUS_M * DEG;
  return {
    origin: { lat: lat0, lng: lng0 },
    toXY: ([lng, lat]) => ({ x: (lng - lng0) * kx, y: (lat - lat0) * ky }),
    toLngLat: ({ x, y }) => [lng0 + x / kx, lat0 + y / ky],
  };
}

/** Cierra el anillo si hace falta y elimina vértices repetidos consecutivos. */
export function normalizeRing(ring: Ring): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push([p[0], p[1]]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push([first[0], first[1]]);
  return out;
}

/** Área con signo (positiva = antihorario) de un anillo en XY. */
export function signedArea(ring: XY[]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n - 1; i++) {
    sum += ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
  }
  return sum / 2;
}

export function ringAreaXY(ring: XY[]): number {
  return Math.abs(signedArea(ring));
}

export function perimeterXY(ring: XY[]): number {
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) total += Math.hypot(ring[i + 1].x - ring[i].x, ring[i + 1].y - ring[i].y);
  return total;
}

export function centroidOfRing(ring: Ring): { lat: number; lng: number } {
  // Promedio de vértices (sin el de cierre): suficiente para centrar la proyección.
  const pts = ring.slice(0, -1);
  const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return { lat, lng };
}

export function pointInRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Punto dentro del polígono (anillo exterior) y fuera de sus huecos. */
export function pointInPolygonXY(p: XY, rings: XY[][]): boolean {
  if (!pointInRing(p, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) if (pointInRing(p, rings[h])) return false;
  return true;
}

function cross(o: XY, a: XY, b: XY): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

export function segmentsIntersect(p1: XY, p2: XY, q1: XY, q2: XY): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function rotate(p: XY, angleRad: number): XY {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Ángulo (radianes, en [0, π)) del lado más largo: la orientación dominante del edificio. */
export function dominantAngle(ring: XY[]): number {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i + 1].x - ring[i].x;
    const dy = ring[i + 1].y - ring[i].y;
    const len = Math.hypot(dx, dy);
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(dy, dx);
    }
  }
  return ((best % Math.PI) + Math.PI) % Math.PI;
}

export function bboxXY(points: XY[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Distancia (m) de un punto a un polígono (0 si está dentro). */
export function distanceToPolygonXY(p: XY, rings: XY[][]): number {
  if (pointInPolygonXY(p, rings)) return 0;
  let min = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) min = Math.min(min, pointSegmentDistance(p, ring[i], ring[i + 1]));
  }
  return min;
}

export interface ProjectedPolygon {
  frame: LocalFrame;
  rings: XY[][];
  areaM2: number;
  perimeterM: number;
  center: { lat: number; lng: number };
}

export function projectPolygon(polygon: GeoPolygon, frame?: LocalFrame): ProjectedPolygon {
  const outer = normalizeRing(polygon.coordinates[0]);
  const center = centroidOfRing(outer);
  const f = frame ?? localFrame(center.lat, center.lng);
  const rings = polygon.coordinates.map((r) => normalizeRing(r).map(f.toXY));
  const holesArea = rings.slice(1).reduce((s, r) => s + ringAreaXY(r), 0);
  return {
    frame: f,
    rings,
    areaM2: ringAreaXY(rings[0]) - holesArea,
    perimeterM: perimeterXY(rings[0]),
    center,
  };
}

/** Distancia haversine en metros. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function bboxAreaKm2(bbox: { south: number; west: number; north: number; east: number }): number {
  const midLat = (bbox.south + bbox.north) / 2;
  const h = haversineM({ lat: bbox.south, lng: bbox.west }, { lat: bbox.north, lng: bbox.west });
  const w = haversineM({ lat: midLat, lng: bbox.west }, { lat: midLat, lng: bbox.east });
  return (h * w) / 1e6;
}
