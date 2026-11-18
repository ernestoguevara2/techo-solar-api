import {
  bboxXY,
  dominantAngle,
  pointInPolygonXY,
  pointInRing,
  pointSegmentDistance,
  projectPolygon,
  rotate,
  segmentsIntersect,
  type GeoPolygon,
  type Position,
  type XY,
} from "./geometry";

/**
 * Distribución automática de paneles sobre un techo (equivalente al
 * "auto-design" de Aurora/OpenSolar/Google Solar, en versión 2D).
 *
 * - Alinea las filas con el lado más largo del edificio (o con el azimut pedido).
 * - Respeta un retiro perimetral (setback) y zonas de exclusión (obstrucciones).
 * - En techos planos con estructura inclinada calcula la separación entre filas
 *   para que una fila no sombree a la siguiente.
 * - Prueba varios desfases de la grilla y ambas orientaciones del panel, y se
 *   queda con la que más paneles coloca.
 */

export type Mounting = "flush" | "tilted_rack";
export type Orientation = "portrait" | "landscape" | "auto";

export interface LayoutOptions {
  panel: { widthM: number; heightM: number; capacityWatts: number };
  orientation: Orientation;
  mounting: Mounting;
  /** Inclinación del panel (estructura en techo plano) o pendiente del techo (flush). */
  tiltDegrees: number;
  setbackM: number;
  colGapM: number;
  rowGapM?: number;
  /** Azimut (brújula, 0 = norte) hacia donde miran los paneles. Si falta se elige automáticamente. */
  azimuthDegrees?: number;
  /** Latitud del sitio: sirve para elegir la cara que mira al ecuador. */
  latitude: number;
  obstructions?: GeoPolygon[];
  obstructionBufferM: number;
  /** Elevación solar mínima de diseño para evitar sombras entre filas. */
  designSunElevationDegrees: number;
  maxPanels: number;
  includeGeometry: boolean;
}

export interface LayoutResult {
  panelsCount: number;
  capacityKwp: number;
  orientation: "portrait" | "landscape";
  azimuthDegrees: number;
  tiltDegrees: number;
  rowPitchM: number;
  rowGapM: number;
  /** Área de módulos (en su plano). */
  modulesAreaM2: number;
  roofAreaM2: number;
  /** Fracción del techo (en planta) cubierta por paneles. */
  groundCoverageRatio: number;
  truncated: boolean;
  panels?: {
    type: "FeatureCollection";
    features: {
      type: "Feature";
      properties: { index: number; row: number; col: number };
      geometry: { type: "Polygon"; coordinates: Position[][] };
    }[];
  };
}

const DEG = Math.PI / 180;

/** Azimut de brújula de un vector local (x = este, y = norte). */
function compassOf(v: XY): number {
  return ((Math.atan2(v.x, v.y) / DEG) % 360 + 360) % 360;
}

function angularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

interface Edge {
  a: XY;
  b: XY;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function edgesOf(rings: XY[][]): Edge[] {
  const edges: Edge[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      edges.push({
        a,
        b,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      });
    }
  }
  return edges;
}

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function rectCorners(r: Rect): XY[] {
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
}

/** Tolerancia (m): tocar un borde no cuenta como salirse ni como invadir. */
const EPS = 1e-6;

function inset(r: Rect): Rect {
  return { minX: r.minX + EPS, minY: r.minY + EPS, maxX: r.maxX - EPS, maxY: r.maxY - EPS };
}

/** ¿Algún borde del polígono invade el rectángulo o queda a menos de `gap` metros? */
function edgesConflict(r: Rect, edges: Edge[], gap: number): boolean {
  const inner = inset(r);
  const corners = rectCorners(inner);
  const limit = gap - EPS;
  for (const e of edges) {
    // Prefiltro por caja envolvente ampliada con la distancia mínima.
    if (e.maxX < r.minX - gap || e.minX > r.maxX + gap) continue;
    if (e.maxY < r.minY - gap || e.minY > r.maxY + gap) continue;
    for (const v of [e.a, e.b]) {
      // Vértice estrictamente dentro del rectángulo.
      if (v.x > inner.minX && v.x < inner.maxX && v.y > inner.minY && v.y < inner.maxY) return true;
      const dx = Math.max(r.minX - v.x, 0, v.x - r.maxX);
      const dy = Math.max(r.minY - v.y, 0, v.y - r.maxY);
      if (Math.hypot(dx, dy) < limit) return true;
    }
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      const q = corners[(i + 1) % 4];
      if (segmentsIntersect(p, q, e.a, e.b)) return true;
      if (limit > 0 && pointSegmentDistance(rectCorners(r)[i], e.a, e.b) < limit) return true;
    }
  }
  return false;
}

/** ¿El rectángulo está dentro del polígono y a `clearance` metros o más de su borde? */
function rectInside(r: Rect, rings: XY[][], edges: Edge[], clearance: number): boolean {
  for (const c of rectCorners(inset(r))) if (!pointInPolygonXY(c, rings)) return false;
  return !edgesConflict(r, edges, clearance);
}

/** ¿El rectángulo queda a `buffer` metros o más de la obstrucción (y no la invade)? */
function rectClearOf(r: Rect, obstacle: XY[][], edges: Edge[], buffer: number): boolean {
  for (const c of rectCorners(inset(r))) if (pointInRing(c, obstacle[0])) return false;
  return !edgesConflict(r, edges, buffer);
}

export function autoRowGap(slopeLengthM: number, tiltDegrees: number, mounting: Mounting, sunElevationDeg: number): number {
  if (mounting === "flush") return 0.02;
  if (tiltDegrees <= 0.5) return 0.05;
  const h = slopeLengthM * Math.sin(tiltDegrees * DEG);
  return Math.max(0.3, h / Math.tan(sunElevationDeg * DEG));
}

export function layoutPanels(roof: GeoPolygon, options: LayoutOptions): LayoutResult {
  const projected = projectPolygon(roof);
  const outer = projected.rings[0];

  // Dirección de las filas (ángulo matemático en el plano local).
  let rowAngle: number;
  let facing: number;
  if (options.azimuthDegrees !== undefined) {
    facing = ((options.azimuthDegrees % 360) + 360) % 360;
    const f: XY = { x: Math.sin(facing * DEG), y: Math.cos(facing * DEG) };
    rowAngle = Math.atan2(f.y, f.x) - Math.PI / 2;
  } else {
    rowAngle = dominantAngle(outer);
    // Las dos caras perpendiculares a las filas: elegimos la que mira al ecuador.
    const target = options.latitude >= 0 ? 180 : 0;
    const faceA = compassOf({ x: -Math.sin(rowAngle), y: Math.cos(rowAngle) });
    const faceB = (faceA + 180) % 360;
    facing = angularDistance(faceA, target) <= angularDistance(faceB, target) ? faceA : faceB;
  }

  // Rotamos todo para que las filas queden paralelas al eje X.
  const rot = (p: XY) => rotate(p, -rowAngle);
  const unrot = (p: XY) => rotate(p, rowAngle);
  const rings = projected.rings.map((r) => r.map(rot));
  const edges = edgesOf(rings);
  const obstacles = (options.obstructions ?? []).map((o) => {
    const rr = o.coordinates.map((ring) => ring.map((pos) => rot(projected.frame.toXY(pos))));
    return { rings: rr, edges: edgesOf(rr) };
  });
  const box = bboxXY(rings[0]);

  const orientations: ("portrait" | "landscape")[] =
    options.orientation === "auto" ? ["portrait", "landscape"] : [options.orientation];

  let best: { rects: Rect[]; orientation: "portrait" | "landscape"; pitch: number; gap: number; truncated: boolean } | null = null;

  for (const orientation of orientations) {
    const alongRow = orientation === "portrait" ? options.panel.widthM : options.panel.heightM;
    const slopeLen = orientation === "portrait" ? options.panel.heightM : options.panel.widthM;
    const depth = slopeLen * Math.cos(options.tiltDegrees * DEG);
    const gap = options.rowGapM ?? autoRowGap(slopeLen, options.tiltDegrees, options.mounting, options.designSunElevationDegrees);
    const pitchY = depth + gap;
    const pitchX = alongRow + options.colGapM;

    for (const fy of [0, 1 / 3, 2 / 3]) {
      for (const fx of [0, 1 / 3, 2 / 3]) {
        const rects: Rect[] = [];
        let truncated = false;
        const y0 = box.minY + options.setbackM + fy * pitchY;
        const x0 = box.minX + options.setbackM + fx * pitchX;
        rows: for (let y = y0; y + depth <= box.maxY - options.setbackM + 1e-9; y += pitchY) {
          for (let x = x0; x + alongRow <= box.maxX - options.setbackM + 1e-9; x += pitchX) {
            const r: Rect = { minX: x, minY: y, maxX: x + alongRow, maxY: y + depth };
            if (!rectInside(r, rings, edges, options.setbackM)) continue;
            if (!obstacles.every((o) => rectClearOf(r, o.rings, o.edges, options.obstructionBufferM))) continue;
            rects.push(r);
            if (rects.length >= options.maxPanels) {
              truncated = true;
              break rows;
            }
          }
        }
        if (!best || rects.length > best.rects.length) best = { rects, orientation, pitch: pitchY, gap, truncated };
      }
    }
  }

  const chosen = best ?? { rects: [], orientation: "portrait" as const, pitch: 0, gap: 0, truncated: false };
  const count = chosen.rects.length;
  const moduleArea = options.panel.widthM * options.panel.heightM;
  const planArea = chosen.rects.reduce((s, r) => s + (r.maxX - r.minX) * (r.maxY - r.minY), 0);

  const result: LayoutResult = {
    panelsCount: count,
    capacityKwp: round((count * options.panel.capacityWatts) / 1000, 3),
    orientation: chosen.orientation,
    azimuthDegrees: round(facing, 1),
    tiltDegrees: options.tiltDegrees,
    rowPitchM: round(chosen.pitch, 3),
    rowGapM: round(chosen.gap, 3),
    modulesAreaM2: round(count * moduleArea, 1),
    roofAreaM2: round(projected.areaM2, 1),
    groundCoverageRatio: projected.areaM2 > 0 ? round(planArea / projected.areaM2, 3) : 0,
    truncated: chosen.truncated,
  };

  if (options.includeGeometry) {
    // Con muchos paneles, 7 decimales (~1 cm) bastan y reducen el tamaño del JSON.
    const toPos = (p: XY): Position => {
      const [lng, lat] = projected.frame.toLngLat(unrot(p));
      return [round(lng, 7), round(lat, 7)];
    };
    const yRows = [...new Set(chosen.rects.map((r) => round(r.minY, 3)))].sort((a, b) => a - b);
    const rowIndex = new Map(yRows.map((y, i) => [y, i]));
    const colCounter = new Map<number, number>();
    result.panels = {
      type: "FeatureCollection",
      features: chosen.rects.map((r, index) => {
        const row = rowIndex.get(round(r.minY, 3)) ?? 0;
        const col = colCounter.get(row) ?? 0;
        colCounter.set(row, col + 1);
        const ring = rectCorners(r).map(toPos);
        ring.push(ring[0]);
        return {
          type: "Feature" as const,
          properties: { index, row, col },
          geometry: { type: "Polygon" as const, coordinates: [ring] },
        };
      }),
    };
  }

  return result;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
