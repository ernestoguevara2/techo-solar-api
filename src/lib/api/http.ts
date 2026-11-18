/**
 * fetch con timeout y User-Agent para proveedores externos
 * (PVGIS, NASA POWER, Overpass, Nominatim, Google Solar).
 */

export class UpstreamError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
  }
}

/** Nominatim y Overpass piden un User-Agent que identifique la app; define UPSTREAM_USER_AGENT con tu contacto. */
export const USER_AGENT = process.env.UPSTREAM_USER_AGENT ?? "TechoSolarAPI/1.0";

export async function fetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...rest.headers },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(provider, `sin respuesta (${reason})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UpstreamError(provider, `HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new UpstreamError(provider, "respuesta no es JSON válido", res.status);
  }
}
