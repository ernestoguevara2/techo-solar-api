import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Autenticación por API key.
 *
 * Configuración (variable de entorno API_KEYS):
 *   API_KEYS="sk_live_abc123:cliente-a,sk_live_def456:cliente-b"
 * Cada entrada es `clave:etiqueta`. La etiqueta identifica al cliente en logs
 * y en el rate limit; nunca se registra la clave.
 *
 * La clave se acepta en `Authorization: Bearer <key>` o en `X-API-Key`.
 */

export interface ApiClient {
  label: string;
  /** Hash corto de la clave: sirve como id estable para el rate limit. */
  keyId: string;
}

interface KeyEntry {
  digest: Buffer;
  client: ApiClient;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Lee API_KEYS. Se recalcula si la variable cambia (útil en tests). */
let cachedRaw: string | undefined;
let cachedEntries: KeyEntry[] = [];

function loadKeys(): KeyEntry[] {
  const raw = process.env.API_KEYS ?? "";
  if (raw === cachedRaw) return cachedEntries;
  cachedRaw = raw;
  cachedEntries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.lastIndexOf(":");
      const key = sep > 0 ? entry.slice(0, sep) : entry;
      const label = sep > 0 ? entry.slice(sep + 1) : "default";
      const digest = sha256(key);
      return { digest, client: { label, keyId: digest.subarray(0, 6).toString("hex") } };
    });
  return cachedEntries;
}

export function authConfigured(): boolean {
  return loadKeys().length > 0;
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

export function extractApiKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const match = BEARER_RE.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const headerKey = headers.get("x-api-key");
  return headerKey ? headerKey.trim() : null;
}

/** Compara en tiempo constante contra todas las claves configuradas. */
export function verifyApiKey(key: string): ApiClient | null {
  const digest = sha256(key);
  let found: ApiClient | null = null;
  for (const entry of loadKeys()) {
    // timingSafeEqual sobre hashes de igual longitud: no filtra por tiempo.
    if (timingSafeEqual(entry.digest, digest)) found = entry.client;
  }
  return found;
}
