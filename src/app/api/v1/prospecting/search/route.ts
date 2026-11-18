import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { prospectingSchema } from "@/lib/schemas";
import { leadsToCsv, leadsToGeoJson, prospect } from "@/lib/services/prospecting";

/**
 * POST /api/v1/prospecting/search — genera una lista de clientes potenciales
 * (techos con mayor potencial) dentro de una zona. Formatos: json, geojson, csv.
 */
export const POST = apiRoute({ cost: 10 }, async (ctx) => {
  const body = await ctx.body(prospectingSchema);
  const result = await prospect(body);

  if (body.format === "csv") {
    return new Response(leadsToCsv(result.leads), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="leads-solares.csv"`,
        ...(result.pagination.nextCursor ? { "x-next-cursor": result.pagination.nextCursor } : {}),
      },
    });
  }
  if (body.format === "geojson") {
    return new Response(JSON.stringify(leadsToGeoJson(result)), {
      headers: { "content-type": "application/geo+json; charset=utf-8" },
    });
  }
  return result;
});

export const OPTIONS = corsPreflight;
