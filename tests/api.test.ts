import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localFrame } from "@/lib/geo/geometry";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { clearIrradianceCache } from "@/lib/providers/irradiance";

/**
 * Pruebas de los route handlers llamándolos directamente con Request.
 * Las llamadas a proveedores externos se simulan con un fetch falso.
 */

const QUITO = { lat: -0.1807, lng: -78.4678 };

function roofPolygon(w: number, h: number, lat = QUITO.lat, lng = QUITO.lng) {
  const f = localFrame(lat, lng);
  const pts = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => f.toLngLat({ x, y }));
  return { type: "Polygon" as const, coordinates: [[...pts, pts[0]]] };
}

const PVGIS_RESPONSE = {
  inputs: { location: { elevation: 2850 } },
  outputs: {
    monthly: Array.from({ length: 24 }, (_, i) => ({
      year: 2014 + Math.floor(i / 12),
      month: (i % 12) + 1,
      "H(h)_m": 145,
      T2m: 14,
    })),
  },
};

function overpassResponse() {
  const roof = roofPolygon(40, 25);
  return {
    elements: [
      {
        type: "way",
        id: 123,
        tags: { building: "warehouse", name: "Bodega Central", phone: "+593 2 000 0000" },
        geometry: roof.coordinates[0].map(([lon, lat]) => ({ lat, lon })),
      },
      {
        type: "way",
        id: 456,
        tags: { building: "house" },
        geometry: roofPolygon(10, 8, QUITO.lat + 0.0005, QUITO.lng).coordinates[0].map(([lon, lat]) => ({ lat, lon })),
      },
    ],
  };
}

const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("re.jrc.ec.europa.eu")) return Response.json(PVGIS_RESPONSE);
  if (url.includes("overpass")) return Response.json(overpassResponse());
  if (url.includes("nominatim")) {
    return Response.json([{ lat: "-0.18", lon: "-78.48", display_name: "Quito, Ecuador", type: "city", category: "place" }]);
  }
  return new Response("not found", { status: 404 });
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-key", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = { authorization: "Bearer test-key" }) {
  return new Request(`http://localhost${path}`, { headers });
}

beforeEach(() => {
  process.env.API_KEYS = "test-key:cliente-prueba";
  process.env.RATE_LIMIT_PER_MINUTE = "1000";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  resetRateLimits();
  clearIrradianceCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("autenticación y errores", () => {
  it("rechaza solicitudes sin API key con 401 problem+json", async () => {
    const { GET } = await import("@/app/api/v1/tariffs/route");
    const res = await GET(get("/api/v1/tariffs", {}));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const body = await res.json();
    expect(body.requestId).toBeTruthy();
    expect(body.instance).toBe("/api/v1/tariffs");
  });

  it("acepta X-API-Key y devuelve x-request-id y cabeceras de rate limit", async () => {
    const { GET } = await import("@/app/api/v1/tariffs/route");
    const res = await GET(get("/api/v1/tariffs", { "x-api-key": "test-key", "x-request-id": "req-12345678" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(res.headers.get("ratelimit-limit")).toBe("1000");
  });

  it("valida el cuerpo y lista los campos con error (422)", async () => {
    const { POST } = await import("@/app/api/v1/production/route");
    const res = await POST(post("/api/v1/production", { location: { lat: 200, lng: 0 }, capacityKwp: -1 }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(["location.lat", "capacityKwp"]));
  });

  it("exige Content-Type JSON (415)", async () => {
    const { POST } = await import("@/app/api/v1/production/route");
    const res = await POST(
      new Request("http://localhost/api/v1/production", {
        method: "POST",
        headers: { authorization: "Bearer test-key", "content-type": "text/plain" },
        body: "hola",
      }),
    );
    expect(res.status).toBe(415);
  });

  it("aplica el rate limit con 429 y Retry-After", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "2";
    const { GET } = await import("@/app/api/v1/solar-resource/route");
    const url = `/api/v1/solar-resource?lat=${QUITO.lat}&lng=${QUITO.lng}`;
    expect((await GET(get(url))).status).toBe(200);
    expect((await GET(get(url))).status).toBe(200);
    const res = await GET(get(url));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("endpoints", () => {
  it("solar-resource usa PVGIS-NSRDB para Ecuador", async () => {
    const { GET } = await import("@/app/api/v1/solar-resource/route");
    const res = await GET(get(`/api/v1/solar-resource?lat=${QUITO.lat}&lng=${QUITO.lng}`));
    const body = await res.json();
    expect(body.source).toBe("pvgis-nsrdb");
    expect(body.monthlyGhiKwhM2Day).toHaveLength(12);
    expect(body.elevationM).toBe(2850);
    expect(String(fetchMock.mock.calls[0][0])).toContain("raddatabase=PVGIS-NSRDB");
  });

  it("cae a cielo despejado si ningún proveedor responde", async () => {
    fetchMock.mockImplementation(async () => new Response("caído", { status: 503 }));
    const { GET } = await import("@/app/api/v1/solar-resource/route");
    const res = await GET(get(`/api/v1/solar-resource?lat=${QUITO.lat}&lng=${QUITO.lng}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source).toBe("clear-sky");
    expect(body.quality).toBe("low");
    expect(body.attempts.filter((a: { ok: boolean }) => !a.ok).length).toBeGreaterThan(0);
    fetchMock.mockReset();
  });

  it("building-insights con polígono del cliente", async () => {
    const { POST } = await import("@/app/api/v1/building-insights/route");
    const res = await POST(
      post("/api/v1/building-insights", {
        roof: roofPolygon(30, 20),
        consumption: { monthlyKwh: 3000, tariffCategory: "comercial" },
        includeLayout: true,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source.footprint).toBe("user");
    expect(body.roof.footprintAreaM2).toBeCloseTo(600, -1);
    expect(body.solarPotential.maxArrayPanelsCount).toBeGreaterThan(50);
    expect(body.solarPotential.monthlyEnergyAcKwh).toHaveLength(12);
    expect(body.panels.features.length).toBe(body.solarPotential.maxArrayPanelsCount);
    expect(body.recommendation.capacityKwp).toBeGreaterThan(0);
    expect(body.recommendation.financialAnalysis.cash.npvUsd).toBeTypeOf("number");
  });

  it("building-insights encuentra el edificio en OpenStreetMap a partir de un punto", async () => {
    const { POST } = await import("@/app/api/v1/building-insights/route");
    const res = await POST(post("/api/v1/building-insights", { location: QUITO }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source.footprint).toBe("openstreetmap");
    expect(body.source.osmId).toBe("way/123");
    expect(body.roof.type).toBe("flat");
  });

  it("si un servidor Overpass falla, usa el siguiente", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("overpass-api.de")) return new Response("saturado", { status: 504 });
      if (url.includes("overpass")) return Response.json(overpassResponse());
      if (url.includes("re.jrc.ec.europa.eu")) return Response.json(PVGIS_RESPONSE);
      return new Response("not found", { status: 404 });
    });
    const { POST } = await import("@/app/api/v1/building-insights/route");
    const res = await POST(post("/api/v1/building-insights", { location: { lat: QUITO.lat + 0.00001, lng: QUITO.lng } }));
    expect(res.status).toBe(200);
    const called = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(called.some((u) => u.includes("overpass-api.de"))).toBe(true);
    expect(called.some((u) => u.includes("overpass.private.coffee"))).toBe(true);
    fetchMock.mockReset();
  });

  it("panel-layout devuelve GeoJSON", async () => {
    const { POST } = await import("@/app/api/v1/panel-layout/route");
    const res = await POST(post("/api/v1/panel-layout", { roof: roofPolygon(20, 10) }));
    const body = await res.json();
    expect(body.panels.type).toBe("FeatureCollection");
    expect(body.panelsCount).toBe(body.panels.features.length);
  });

  it("financial-analysis calcula con producción enviada por el cliente", async () => {
    const { POST } = await import("@/app/api/v1/financial-analysis/route");
    const res = await POST(
      post("/api/v1/financial-analysis", {
        capacityKwp: 20,
        monthlyProductionKwh: 2300,
        consumption: { monthlyBillUsd: 300, tariffCategory: "comercial" },
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.productionSource).toBe("user");
    expect(body.cash.cashFlows).toHaveLength(25);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prospecting ordena leads y exporta CSV", async () => {
    const { POST } = await import("@/app/api/v1/prospecting/search/route");
    const json = await POST(post("/api/v1/prospecting/search", { center: QUITO, radiusM: 300, minRoofAreaM2: 50 }));
    const body = await json.json();
    expect(json.status).toBe(200);
    expect(body.leads[0].osmId).toBe("way/123");
    expect(body.leads[0].leadScore).toBeGreaterThan(body.leads[1].leadScore);
    expect(body.leads[0].contact.phone).toBeTruthy();

    const csv = await POST(post("/api/v1/prospecting/search", { center: QUITO, radiusM: 300, minRoofAreaM2: 50, format: "csv" }));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toContain("leadScore");
    expect(text).toContain("Bodega Central");
    // Las coordenadas negativas no deben tratarse como fórmulas.
    expect(text).toMatch(/,-78\.\d+,/);
    expect(text).not.toContain("'-78");
  });

  it("prospecting rechaza áreas demasiado grandes sin llamar a Overpass", async () => {
    const { POST } = await import("@/app/api/v1/prospecting/search/route");
    const res = await POST(post("/api/v1/prospecting/search", { bbox: { south: -0.3, west: -78.6, north: -0.1, east: -78.4 } }));
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proposals genera HTML con la marca del instalador y escapa el texto", async () => {
    const { POST } = await import("@/app/api/v1/proposals/route");
    const res = await POST(
      post("/api/v1/proposals", {
        insights: { roof: roofPolygon(20, 15), consumption: { monthlyBillUsd: 250, tariffCategory: "comercial" } },
        customer: { name: "<script>alert(1)</script> Panadería" },
        installer: { name: "Solar Andes", primaryColor: "#0f766e" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("Solar Andes");
    expect(html).toContain("#0f766e");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("batch procesa ítems de forma independiente", async () => {
    const { POST } = await import("@/app/api/v1/building-insights/batch/route");
    const res = await POST(
      post("/api/v1/building-insights/batch", {
        items: [{ id: "ok", roof: roofPolygon(20, 20) }, { id: "sin-datos" }],
      }),
    );
    const body = await res.json();
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[1].error.type).toBe("validation-error");
  });

  it("openapi.json es público y documenta los endpoints", async () => {
    const { GET } = await import("@/app/api/v1/openapi.json/route");
    const res = await GET(get("/api/v1/openapi.json", {}));
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/api/v1/building-insights");
    expect(doc.paths["/api/v1/building-insights"].post.requestBody.content["application/json"].schema.properties.location).toBeTruthy();
  });
});
