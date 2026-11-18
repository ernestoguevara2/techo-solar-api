import { LRUCache } from "lru-cache";

/**
 * Caché entre solicitudes (regla server-cache-lru del skill de Vercel).
 *
 * Guarda la *promesa*, no solo el resultado: si dos solicitudes piden lo mismo
 * al mismo tiempo, comparten una sola llamada al proveedor externo.
 * Si la promesa falla se elimina para no cachear errores.
 */
export function createPromiseCache<V extends object>(options: { max: number; ttlMs: number }) {
  const cache = new LRUCache<string, Promise<V>>({ max: options.max, ttl: options.ttlMs });

  return {
    get(key: string, load: () => Promise<V>): Promise<V> {
      const hit = cache.get(key);
      if (hit) return hit;
      const promise = load();
      cache.set(key, promise);
      promise.catch(() => {
        if (cache.get(key) === promise) cache.delete(key);
      });
      return promise;
    },
    clear() {
      cache.clear();
    },
    get size() {
      return cache.size;
    },
  };
}
