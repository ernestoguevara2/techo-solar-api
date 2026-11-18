import { LRUCache } from "lru-cache";

/**
 * Rate limit tipo token bucket por cliente.
 *
 * Vive en memoria del proceso: con Vercel Fluid Compute las solicitudes
 * concurrentes comparten instancia, así que funciona bien para un cliente.
 * Si se escala a muchas instancias, reemplazar por Redis/Upstash
 * manteniendo esta misma interfaz.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Segundos hasta que haya al menos un token disponible. */
  resetSeconds: number;
}

// Caché intencionalmente compartida entre solicitudes (regla server-no-shared-module-state:
// excepción válida porque está indexada por cliente y no guarda datos de la respuesta).
const buckets = new LRUCache<string, Bucket>({ max: 10_000, ttl: 60 * 60 * 1000 });

export function perMinuteLimit(): number {
  const n = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

export function consume(key: string, cost = 1, limit = perMinuteLimit(), now = Date.now()): RateLimitResult {
  const refillPerMs = limit / 60_000;
  const bucket = buckets.get(key) ?? { tokens: limit, updatedAt: now };
  const tokens = Math.min(limit, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);

  if (tokens < cost) {
    buckets.set(key, { tokens, updatedAt: now });
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetSeconds: Math.ceil((cost - tokens) / refillPerMs / 1000),
    };
  }

  const remaining = tokens - cost;
  buckets.set(key, { tokens: remaining, updatedAt: now });
  return {
    allowed: true,
    limit,
    remaining: Math.floor(remaining),
    resetSeconds: Math.ceil((limit - remaining) / refillPerMs / 1000),
  };
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    "ratelimit-limit": String(r.limit),
    "ratelimit-remaining": String(r.remaining),
    "ratelimit-reset": String(r.resetSeconds),
  };
}

/** Solo para tests. */
export function resetRateLimits(): void {
  buckets.clear();
}
