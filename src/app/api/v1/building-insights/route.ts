import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { buildingInsightsSchema } from "@/lib/schemas";
import { computeBuildingInsights } from "@/lib/services/building-insights";

/**
 * POST /api/v1/building-insights
 * Potencial solar de un edificio a partir de un punto (busca la huella en
 * OpenStreetMap) o de un polígono enviado por el cliente.
 */
export const POST = apiRoute({ cost: 3, maxBodyBytes: 2 * 1024 * 1024 }, async (ctx) => {
  const body = await ctx.body(buildingInsightsSchema);
  return computeBuildingInsights(body);
});

export const OPTIONS = corsPreflight;
