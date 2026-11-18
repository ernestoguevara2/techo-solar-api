import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { geocode } from "@/lib/providers/osm";
import { geocodeQuerySchema } from "@/lib/schemas";

/** GET /api/v1/geocode?q=Av. Amazonas y Naciones Unidas, Quito — dirección → coordenadas. */
export const GET = apiRoute({ cost: 1 }, async (ctx) => {
  const q = ctx.query(geocodeQuerySchema);
  const results = await geocode(q.q, q.country, q.limit);
  return { query: q.q, results, attribution: "© colaboradores de OpenStreetMap (Nominatim)" };
});

export const OPTIONS = corsPreflight;
