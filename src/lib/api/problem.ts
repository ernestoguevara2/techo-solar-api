/**
 * Errores en formato RFC 9457 (application/problem+json).
 * Todos los endpoints responden errores con esta forma para que el cliente
 * pueda manejarlos de manera uniforme.
 */

export type ProblemType =
  | "validation-error"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "payload-too-large"
  | "unsupported-media-type"
  | "upstream-unavailable"
  | "area-too-large"
  | "internal-error"
  | "misconfigured";

const TITLES: Record<ProblemType, string> = {
  "validation-error": "La solicitud no es válida",
  unauthorized: "Falta la API key o no es válida",
  forbidden: "No tienes permiso para este recurso",
  "not-found": "Recurso no encontrado",
  "rate-limited": "Demasiadas solicitudes",
  "payload-too-large": "El cuerpo de la solicitud es demasiado grande",
  "unsupported-media-type": "Tipo de contenido no soportado",
  "upstream-unavailable": "Un proveedor de datos externo no respondió",
  "area-too-large": "El área solicitada es demasiado grande",
  "internal-error": "Error interno",
  misconfigured: "El servidor no está configurado correctamente",
};

const STATUS: Record<ProblemType, number> = {
  "validation-error": 422,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  "rate-limited": 429,
  "payload-too-large": 413,
  "unsupported-media-type": 415,
  "upstream-unavailable": 503,
  "area-too-large": 422,
  "internal-error": 500,
  misconfigured: 500,
};

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
  [extension: string]: unknown;
}

export class ApiError extends Error {
  readonly problemType: ProblemType;
  readonly status: number;
  readonly extensions: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    problemType: ProblemType,
    detail?: string,
    options: { extensions?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(detail ?? TITLES[problemType]);
    this.problemType = problemType;
    this.status = STATUS[problemType];
    this.extensions = options.extensions ?? {};
    this.headers = options.headers ?? {};
  }
}

export function problemBody(
  problemType: ProblemType,
  detail: string | undefined,
  extras: { instance?: string; requestId?: string; extensions?: Record<string, unknown> } = {},
): ProblemBody {
  return {
    type: `/docs#problema-${problemType}`,
    title: TITLES[problemType],
    status: STATUS[problemType],
    ...(detail ? { detail } : {}),
    ...(extras.instance ? { instance: extras.instance } : {}),
    ...(extras.requestId ? { requestId: extras.requestId } : {}),
    ...extras.extensions,
  };
}

export function problemResponse(body: ProblemBody, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { ...Object.fromEntries(new Headers(headers)), "content-type": "application/problem+json" },
  });
}
