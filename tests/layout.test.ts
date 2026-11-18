import { describe, expect, it } from "vitest";
import { localFrame, projectPolygon, type GeoPolygon } from "@/lib/geo/geometry";
import { layoutPanels, type LayoutOptions } from "@/lib/geo/layout";

/** Rectángulo de `w` × `h` metros (este × norte) centrado en (lat, lng), rotado `rotDeg`. */
function rectRoof(w: number, h: number, lat = -2.17, lng = -79.9, rotDeg = 0): GeoPolygon {
  const f = localFrame(lat, lng);
  const a = (rotDeg * Math.PI) / 180;
  const pts = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => f.toLngLat({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }));
  return { type: "Polygon", coordinates: [[...pts, pts[0]]] };
}

const base: LayoutOptions = {
  panel: { widthM: 1, heightM: 2, capacityWatts: 500 },
  orientation: "portrait",
  mounting: "flush",
  tiltDegrees: 0,
  setbackM: 0,
  colGapM: 0,
  rowGapM: 0,
  latitude: -2.17,
  obstructionBufferM: 0,
  designSunElevationDegrees: 25,
  maxPanels: 10_000,
  includeGeometry: true,
};

describe("geometría", () => {
  it("calcula el área de un rectángulo de 20 × 10 m", () => {
    expect(projectPolygon(rectRoof(20, 10)).areaM2).toBeCloseTo(200, 0);
  });
});

describe("distribución de paneles", () => {
  it("llena un techo de 20 × 10 m con paneles de 1 × 2 m (100 paneles, 50 kWp)", () => {
    const r = layoutPanels(rectRoof(20.001, 10.001), base);
    expect(r.panelsCount).toBe(100);
    expect(r.capacityKwp).toBe(50);
    expect(r.panels?.features).toHaveLength(100);
    expect(r.groundCoverageRatio).toBeGreaterThan(0.99);
  });

  it("respeta el retiro perimetral", () => {
    const r = layoutPanels(rectRoof(20.001, 10.001), { ...base, setbackM: 1 });
    // Queda un área útil de 18 × 8 m → 18 columnas × 4 filas.
    expect(r.panelsCount).toBe(72);
  });

  it("alinea la grilla con un edificio rotado 30°", () => {
    const r = layoutPanels(rectRoof(20.001, 10.001, -2.17, -79.9, 30), base);
    expect(r.panelsCount).toBe(100);
  });

  it("evita las obstrucciones (tragaluz de 4 × 4 m en el centro)", () => {
    const roof = rectRoof(20.001, 10.001);
    const skylight = rectRoof(4, 4);
    const r = layoutPanels(roof, { ...base, obstructions: [skylight] });
    // El tragaluz tapa 4 columnas × 2 filas exactas, o hasta 5 × 3 si la grilla no queda alineada con él.
    expect(r.panelsCount).toBeLessThan(100);
    expect(r.panelsCount).toBeGreaterThanOrEqual(100 - 15);
    // Ningún panel invade el tragaluz.
    const f = localFrame(-2.17, -79.9);
    for (const feat of r.panels!.features) {
      const xs = feat.geometry.coordinates[0].map((p) => f.toXY(p));
      const minX = Math.min(...xs.map((p) => p.x));
      const maxX = Math.max(...xs.map((p) => p.x));
      const minY = Math.min(...xs.map((p) => p.y));
      const maxY = Math.max(...xs.map((p) => p.y));
      const overlaps = maxX > -2 + 1e-3 && minX < 2 - 1e-3 && maxY > -2 + 1e-3 && minY < 2 - 1e-3;
      expect(overlaps).toBe(false);
    }
  });

  it("deja separación entre filas en estructuras inclinadas", () => {
    const flush = layoutPanels(rectRoof(30, 30), { ...base, setbackM: 1 });
    const rack = layoutPanels(rectRoof(30, 30), { ...base, setbackM: 1, mounting: "tilted_rack", tiltDegrees: 10, rowGapM: undefined });
    expect(rack.rowGapM).toBeGreaterThan(0.3);
    expect(rack.panelsCount).toBeLessThan(flush.panelsCount);
  });

  it("en el hemisferio sur los paneles miran al norte", () => {
    const r = layoutPanels(rectRoof(30, 10), { ...base, latitude: -2.17 });
    expect(Math.min(r.azimuthDegrees, 360 - r.azimuthDegrees)).toBeLessThan(1);
  });

  it("no coloca paneles fuera de un techo en L (cóncavo)", () => {
    const f = localFrame(-2.17, -79.9);
    const L = [
      [0, 0],
      [20, 0],
      [20, 6],
      [6, 6],
      [6, 20],
      [0, 20],
      [0, 0],
    ].map(([x, y]) => f.toLngLat({ x, y }));
    const r = layoutPanels({ type: "Polygon", coordinates: [L] }, base);
    // Área = 20×6 + 6×14 = 204 m² → como máximo 102 paneles de 2 m².
    expect(r.panelsCount).toBeLessThanOrEqual(102);
    expect(r.panelsCount).toBeGreaterThan(80);
  });
});
