import { apiRoute } from "@/lib/api/handler";
import { openApiDocument } from "@/lib/openapi";

/** GET /api/v1/openapi.json — especificación OpenAPI 3.1 (pública). */
export const GET = apiRoute({ auth: false }, async () => openApiDocument);
