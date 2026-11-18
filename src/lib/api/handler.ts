import { after, connection } from "next/server";
import type { z } from "zod";
import { authConfigured, extractApiKey, verifyApiKey, type ApiClient } from "./auth";
import { UpstreamError } from "./http";
import { ApiError, problemBody, problemResponse } from "./problem";
import { consume, rateLimitHeaders } from "./rate-limit";

/**
 * Envoltura común para todos los endpoints /api/v1/*.
 *
 * Orden pensado según el skill de Vercel (async-cheap-condition-before-await):
 * primero lo barato y síncrono (request id, auth, rate limit), y solo después
 * el trabajo caro (parsear el cuerpo, llamar proveedores externos).
 * El log de uso se hace con after() para no retrasar la respuesta
 * (server-after-nonblocking).
 */

export interface ApiContext {
  request: Request;
  url: URL;
  requestId: string;
  client: ApiClient;
  /** Lee y valida el cuerpo JSON. Lanza 415/413/422 si corresponde. */
  body<S extends z.ZodType>(schema: S): Promise<z.output<S>>;
  /** Valida los query params. Lanza 422 si no cumplen el schema. */
  query<S extends z.ZodType>(schema: S): z.output<S>;
}

export interface RouteOptions {
  /** Tokens del rate limit que consume la llamada (endpoints caros cuestan más). */
  cost?: number;
  /** false para endpoints públicos (health, openapi). */
  auth?: boolean;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 512 * 1024;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

function corsHeaders(request: Request): Record<string, string> {
  const allowed = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin");
  if (!origin || allowed.length === 0) return {};
  if (!allowed.includes("*") && !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": allowed.includes("*") ? "*" : origin,
    "access-control-expose-headers":
      "x-request-id, ratelimit-limit, ratelimit-remaining, ratelimit-reset, retry-after",
    vary: "Origin",
  };
}

export function corsPreflight(request: Request): Response {
  const headers = corsHeaders(request);
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-api-key, x-request-id",
      "access-control-max-age": "86400",
    },
  });
}

/** after() programa el log para después de enviar la respuesta (en tests se mockea next/server). */
function runAfter(task: () => void): void {
  after(task);
}

function formatIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(raíz)",
    message: issue.message,
  }));
}

function validationError(error: z.ZodError, where: string): ApiError {
  return new ApiError("validation-error", `Revisa los campos del ${where}.`, {
    extensions: { errors: formatIssues(error) },
  });
}

function resolveClient(request: Request): ApiClient {
  if (!authConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError("misconfigured", "Define la variable API_KEYS antes de publicar la API.");
    }
    return { label: "dev-sin-auth", keyId: "dev" };
  }
  const key = extractApiKey(request.headers);
  if (!key) {
    throw new ApiError("unauthorized", "Envía tu clave en 'Authorization: Bearer <API_KEY>' o 'X-API-Key'.", {
      headers: { "www-authenticate": 'Bearer realm="techo-solar"' },
    });
  }
  const client = verifyApiKey(key);
  if (!client) {
    throw new ApiError("unauthorized", "La API key no es válida.", {
      headers: { "www-authenticate": 'Bearer realm="techo-solar", error="invalid_token"' },
    });
  }
  return client;
}

export function apiRoute(
  options: RouteOptions,
  handler: (ctx: ApiContext) => Promise<Response | object>,
): (request: Request) => Promise<Response> {
  const { cost = 1, auth = true, maxBodyBytes = DEFAULT_MAX_BODY } = options;

  return async function route(request: Request): Promise<Response> {
    // Con cacheComponents, un GET que no lee datos de runtime se prerenderiza en el build.
    // Una API siempre debe ser dinámica: lo declaramos explícitamente, fuera del try,
    // porque Next usa ese rechazo internamente para marcar la ruta como dinámica.
    await connection();
    const started = performance.now();
    const incomingId = request.headers.get("x-request-id");
    const requestId = incomingId && REQUEST_ID_RE.test(incomingId) ? incomingId : crypto.randomUUID();
    const url = new URL(request.url);
    const baseHeaders: Record<string, string> = { "x-request-id": requestId, ...corsHeaders(request) };
    let client: ApiClient = { label: "anónimo", keyId: "anon" };
    let status = 500;

    try {
      if (auth) {
        client = resolveClient(request);
        if (client.keyId === "dev") baseHeaders["x-auth-mode"] = "disabled-dev";
        const rl = consume(client.keyId, cost);
        Object.assign(baseHeaders, rateLimitHeaders(rl));
        if (!rl.allowed) {
          throw new ApiError("rate-limited", `Límite de ${rl.limit} unidades por minuto alcanzado.`, {
            headers: { "retry-after": String(rl.resetSeconds) },
          });
        }
      }

      const ctx: ApiContext = {
        request,
        url,
        requestId,
        client,
        async body(schema) {
          const type = request.headers.get("content-type") ?? "";
          if (!type.toLowerCase().includes("application/json")) {
            throw new ApiError("unsupported-media-type", "Usa 'Content-Type: application/json'.");
          }
          const declared = Number(request.headers.get("content-length") ?? 0);
          if (declared > maxBodyBytes) {
            throw new ApiError("payload-too-large", `Máximo ${Math.round(maxBodyBytes / 1024)} KB.`);
          }
          const text = await request.text();
          if (text.length > maxBodyBytes) {
            throw new ApiError("payload-too-large", `Máximo ${Math.round(maxBodyBytes / 1024)} KB.`);
          }
          let data: unknown;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            throw new ApiError("validation-error", "El cuerpo no es JSON válido.");
          }
          const parsed = schema.safeParse(data);
          if (!parsed.success) throw validationError(parsed.error, "cuerpo");
          return parsed.data;
        },
        query(schema) {
          const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
          if (!parsed.success) throw validationError(parsed.error, "query string");
          return parsed.data;
        },
      };

      const result = await handler(ctx);
      const response = result instanceof Response ? result : Response.json(result);
      for (const [k, v] of Object.entries(baseHeaders)) response.headers.set(k, v);
      status = response.status;
      return response;
    } catch (err) {
      let response: Response;
      if (err instanceof ApiError) {
        response = problemResponse(
          problemBody(err.problemType, err.message, {
            instance: url.pathname,
            requestId,
            extensions: err.extensions,
          }),
          { ...baseHeaders, ...err.headers },
        );
      } else if (err instanceof UpstreamError) {
        response = problemResponse(
          problemBody("upstream-unavailable", err.message, {
            instance: url.pathname,
            requestId,
            extensions: { provider: err.provider },
          }),
          { ...baseHeaders, "retry-after": "30" },
        );
      } else {
        console.error(JSON.stringify({ level: "error", requestId, path: url.pathname, error: String(err) }));
        response = problemResponse(
          problemBody("internal-error", "Ocurrió un error inesperado. Comparte el requestId con soporte.", {
            instance: url.pathname,
            requestId,
          }),
          baseHeaders,
        );
      }
      status = response.status;
      return response;
    } finally {
      const durationMs = Math.round(performance.now() - started);
      const label = client.label;
      runAfter(() => {
        if (process.env.LOG_REQUESTS === "false") return;
        console.info(
          JSON.stringify({
            level: "info",
            msg: "api_request",
            requestId,
            client: label,
            method: request.method,
            path: url.pathname,
            status,
            durationMs,
          }),
        );
      });
    }
  };
}
