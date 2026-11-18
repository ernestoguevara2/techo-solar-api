import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { PANEL_CATALOG } from "@/lib/solar/panels";

/** GET /api/v1/panels — catálogo de paneles genéricos disponibles. */
export const GET = apiRoute({ cost: 0 }, async () => ({ panels: PANEL_CATALOG }));

export const OPTIONS = corsPreflight;
