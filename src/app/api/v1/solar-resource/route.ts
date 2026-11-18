import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { getSolarResource } from "@/lib/providers/irradiance";
import { solarResourceQuerySchema } from "@/lib/schemas";

/** GET /api/v1/solar-resource?lat=-0.18&lng=-78.47 — irradiación y temperatura mensual. */
export const GET = apiRoute({ cost: 1 }, async (ctx) => {
  const q = ctx.query(solarResourceQuerySchema);
  const resource = await getSolarResource(q.lat, q.lng, { preferred: q.source });
  return {
    ...resource,
    units: { monthlyGhiKwhM2Day: "kWh/m²/día", monthlyTempC: "°C", annualGhiKwhM2: "kWh/m²/año" },
  };
});

export const OPTIONS = corsPreflight;
