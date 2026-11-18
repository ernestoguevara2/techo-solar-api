import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { proposalSchema } from "@/lib/schemas";
import { computeBuildingInsights } from "@/lib/services/building-insights";
import { renderProposalHtml } from "@/lib/services/proposal";

/**
 * POST /api/v1/proposals — propuesta comercial con la marca del instalador.
 * format=html devuelve la página lista para imprimir o guardar como PDF;
 * format=json devuelve { html, insights } para incrustarla en otra app.
 */
export const POST = apiRoute({ cost: 4, maxBodyBytes: 2 * 1024 * 1024 }, async (ctx) => {
  const body = await ctx.body(proposalSchema);
  const insights = await computeBuildingInsights({ ...body.insights, includeLayout: false });
  const html = renderProposalHtml(body, insights);

  if (body.format === "json") return { html, insights };
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // La página no ejecuta scripts: CSP estricta como defensa adicional.
      "content-security-policy": "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
});

export const OPTIONS = corsPreflight;
