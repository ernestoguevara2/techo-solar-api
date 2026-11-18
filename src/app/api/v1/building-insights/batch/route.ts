import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { ApiError } from "@/lib/api/problem";
import { UpstreamError } from "@/lib/api/http";
import { batchBuildingInsightsSchema, buildingInsightsSchema } from "@/lib/schemas";
import { computeBuildingInsights } from "@/lib/services/building-insights";

const CONCURRENCY = 4;

/** Ejecuta tareas con un máximo de `limit` en paralelo y conserva el orden. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * POST /api/v1/building-insights/batch — hasta 25 edificios por llamada
 * (útil para precalificar una lista de clientes potenciales).
 * Cada ítem responde por separado: un fallo no tumba el lote.
 */
export const POST = apiRoute({ cost: 10, maxBodyBytes: 4 * 1024 * 1024 }, async (ctx) => {
  const body = await ctx.body(batchBuildingInsightsSchema);

  const results = await mapPool(body.items, CONCURRENCY, async (item, index) => {
    const id = item.id ?? String(index);
    const parsed = buildingInsightsSchema.safeParse({ ...body.defaults, location: item.location, roof: item.roof });
    if (!parsed.success) {
      return { id, status: "error" as const, error: { type: "validation-error", detail: parsed.error.issues[0]?.message } };
    }
    try {
      return { id, status: "ok" as const, data: await computeBuildingInsights(parsed.data) };
    } catch (err) {
      const type = err instanceof ApiError ? err.problemType : err instanceof UpstreamError ? "upstream-unavailable" : "internal-error";
      return { id, status: "error" as const, error: { type, detail: err instanceof Error ? err.message : String(err) } };
    }
  });

  return {
    count: results.length,
    succeeded: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "error").length,
    results,
  };
});

export const OPTIONS = corsPreflight;
