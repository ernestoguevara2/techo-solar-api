# Techo Solar API

API de análisis solar de techos con imágenes satelitales y datos abiertos, pensada para **empresas instaladoras de paneles solares en Ecuador**. Incluye una demo web con mapa satelital.

- **Edificios**: potencial solar por techo a partir de un punto o un polígono.
- **Diseño**: distribución automática de paneles con retiros, obstrucciones y separación entre filas.
- **Producción**: kWh mensuales y anuales con un modelo tipo PVWatts.
- **Finanzas (Ecuador)**: Tarifa Dignidad, balance neto, IVA 0 %, doble depreciación, VAN, TIR, payback, LCOE y crédito.
- **Prospección**: encuentra los mejores techos comerciales e industriales de una zona y los exporta a CSV para el CRM.
- **Ventas**: propuesta en HTML con la marca del instalador, lista para imprimir o guardar como PDF.

Stack: Next.js 16 (App Router, Route Handlers) + TypeScript + zod. Se construyó siguiendo el skill **Vercel React Best Practices**, instalado en `.claude/skills/vercel-react-best-practices` (ver la sección *Buenas prácticas aplicadas*).

---

## Inicio rápido

```bash
npm install
cp .env.example .env.local   # edita API_KEYS
npm run dev                  # http://localhost:3000
```

- Demo con mapa: `http://localhost:3000/`
- Documentación interactiva: `http://localhost:3000/docs`
- OpenAPI 3.1: `http://localhost:3000/api/v1/openapi.json`

```bash
npm test          # 42 pruebas (motor solar, distribución de paneles, finanzas, endpoints)
npm run typecheck
npm run lint
npm run build
```

### Ejemplo

```bash
curl -X POST http://localhost:3000/api/v1/building-insights \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"location":{"lat":-2.1894,"lng":-79.8891},
       "consumption":{"monthlyBillUsd":900,"tariffCategory":"comercial"},
       "includeLayout":true}'
```

---

## Endpoints

| Método | Ruta | Qué hace | Unidades de rate limit |
|---|---|---|---|
| POST | `/api/v1/building-insights` | Potencial del techo: huella, paneles, kWp, producción mensual, configuraciones, recomendación y finanzas | 3 |
| POST | `/api/v1/building-insights/batch` | Hasta 25 edificios por llamada; cada ítem responde por separado | 10 |
| POST | `/api/v1/panel-layout` | Distribución de paneles sobre un polígono (GeoJSON por panel) | 2 |
| POST | `/api/v1/production` | Producción tipo PVWatts: mensual, anual, PR, pérdidas, degradación | 1 |
| POST | `/api/v1/financial-analysis` | Ahorro mensual, flujo a 25 años, VAN, TIR, payback, LCOE, CO₂ y crédito | 1 |
| POST | `/api/v1/prospecting/search` | Leads de una zona (máx. 4 km²) con puntaje A/B/C; `json`, `geojson` o `csv` | 10 |
| POST | `/api/v1/proposals` | Propuesta comercial HTML con marca (o JSON con el HTML) | 4 |
| GET | `/api/v1/solar-resource` | Irradiación (GHI) y temperatura mensual | 1 |
| GET | `/api/v1/geocode` | Dirección → coordenadas (Nominatim) | 1 |
| GET | `/api/v1/tariffs` | Supuestos tarifarios, tributarios y financieros de Ecuador | 0 |
| GET | `/api/v1/panels` | Catálogo de paneles genéricos | 0 |
| GET | `/api/v1/health` | Estado y configuración (público) | — |
| GET | `/api/v1/openapi.json` | Especificación OpenAPI 3.1 (pública) | — |

**Convenciones**
- Autenticación: `Authorization: Bearer <API_KEY>` o `X-API-Key`. Las claves se configuran en `API_KEYS` y se comparan por hash en tiempo constante.
- Errores en formato RFC 9457 (`application/problem+json`) con `requestId` y, en validaciones, la lista `errors[]` por campo (mensajes en español).
- Rate limit por cliente con las cabeceras `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` y `Retry-After`.
- `X-Request-Id` se acepta y se devuelve para trazar solicitudes.
- Versionado en la ruta (`/api/v1`).
- Coordenadas WGS84; los polígonos son GeoJSON `[lng, lat]`.
- Todos los supuestos (tarifa, costo por Wp, pérdidas, tasa de descuento…) se pueden sobrescribir por solicitud.

---

## Funciones frente a la competencia

Investigación de Google Solar API, Aurora Solar, OpenSolar, NREL PVWatts, PVGIS, Solcast, EagleView, Planno, Enphase Solargraf, Scanifly y SurgePV.

| Función | Quién la ofrece | Techo Solar API |
|---|---|---|
| Potencial por edificio (paneles máx., kWp, horas de sol, configuraciones) | Google Solar `buildingInsights` | ✅ `building-insights` (`panelConfigs` equivalente a `solarPanelConfigs`) |
| Análisis financiero por tamaño de planilla | Google Solar `financialAnalyses` | ✅ adaptado a Ecuador (Tarifa Dignidad, balance neto, doble depreciación, IVA 0 %) |
| Diseño automático de paneles | Aurora AutoDesigner, OpenSolar, SurgePV | ✅ 2D con retiros, obstrucciones, filas sin sombra y alineado al edificio |
| Simulación de producción y pérdidas | PVWatts, Aurora Performance Simulation | ✅ modelo mensual tipo PVWatts (pérdidas por defecto 14,08 %) |
| Datos de irradiancia y temperatura | PVGIS, NASA POWER, Solcast, Solargis | ✅ PVGIS-NSRDB → NASA POWER → PVGIS-ERA5 → cielo despejado |
| Escenarios de financiamiento | Aurora Financings | ✅ contado y crédito (cuota, VAN, TIR) |
| Propuestas con marca | Aurora Proposals, Solargraf, OpenSolar | ✅ HTML imprimible (PDF desde el navegador) |
| Prospección de techos comerciales e industriales | Planno | ✅ puntaje A/B/C, contactos de OSM, exportación CSV y GeoJSON |
| Procesamiento por lotes | Planno, Solcast | ✅ `batch` (25 edificios) |
| Geocodificación | Aurora, OpenSolar | ✅ Nominatim, filtrado a Ecuador |
| Fuente Google Solar cuando hay cobertura | — | ✅ opcional con `GOOGLE_SOLAR_API_KEY` (Perú, Colombia, México, Brasil) |
| Capas raster DSM / flux / sombra horaria (GeoTIFF) | Google Solar `dataLayers` | ❌ hoja de ruta (requiere DSM/LiDAR o imágenes estéreo) |
| Modelo 3D, pendiente medida y TSRF | EagleView, Scanifly (drones) | ❌ la pendiente sale de etiquetas OSM o la envía el cliente |
| Detección de techos por IA sobre la imagen | Planno, Solargraf, SurgePV | ❌ usa huellas de OSM; hoja de ruta: Microsoft/Google Open Buildings + segmentación |
| Strings, inversores, BOM, diagrama unifilar, planos de permisos | SurgePV, Solargraf, Aurora | ❌ hoja de ruta |
| CRM, firma electrónica, webhooks | Aurora, OpenSolar | ❌ hoja de ruta |
| Pronóstico de producción (días siguientes) | Solcast | ❌ fuera de alcance por ahora |

**Diferenciadores para Ecuador:** reglas tarifarias y tributarias locales, todo en español, sin depender de Google (que no publica cobertura para Ecuador) y con proveedores gratuitos con respaldo automático.

---

## Cómo funciona

1. **Huella del edificio**: polígono enviado por el cliente (calidad alta) o el edificio de OpenStreetMap que contiene el punto (Overpass). Si el punto no cae dentro de un edificio, se usa el más cercano dentro de `searchRadiusM`.
2. **Tipo de techo**: se toma de `roof:shape`, `roof:angle` y `roof:direction` de OSM, o lo envía el cliente. Por defecto se asume plano, porque en Ecuador predominan las losas de hormigón.
3. **Distribución de paneles**:
   - En techo plano: estructura a 10° mirando al ecuador, con separación entre filas calculada para una elevación solar de diseño de 25°.
   - En techo inclinado: paneles coplanares.
   - Se prueban 9 desfases de la grilla y las dos orientaciones del panel, y se queda la que más paneles coloca.
4. **Irradiancia**: GHI y temperatura mensual con caché LRU de 30 días por celda de ~1 km.
5. **Producción**: método Duffie & Beckman (Erbs, Collares-Pereira & Rabl, cielo isotrópico + albedo), pérdida por ángulo de incidencia ASHRAE, modelo térmico NOCT y pérdidas tipo PVWatts.
6. **Finanzas**: simulación mes a mes por 25 años con degradación, escalamiento tarifario, O&M, reemplazo de inversor, efecto tributario para empresas y escenario de crédito.

### Supuestos referenciales (editables)

Están en `src/lib/finance/tariffs-ec.ts` y se exponen en `GET /api/v1/tariffs`.

- **Tarifas (USD/kWh):** residencial 0,10 (promedio nacional pagado ≈ 10,6 ¢), comercial 0,092, industrial 0,085. No se modelan cargos por demanda.
- **Tarifa Dignidad:** 4 ¢/kWh hasta 110 kWh/mes (Sierra) y 130 kWh/mes (Costa).
- **Costo instalado (USD/Wp):** residencial 1,40, comercial 1,20, industrial 1,10.
- **Supuestos financieros:** tasa de descuento 9 %, impuesto a la renta 25 %, depreciación a 10 años, IVA 0 % en equipos.
- **Factor de emisión:** 0,30 kg CO₂/kWh. Reemplázalo por el factor oficial de CENACE/MEM.

> Son valores para **estimaciones comerciales preliminares**. Antes de una oferta firme, usa la planilla real del cliente, el pliego vigente de ARCONEL y la regulación de generación distribuida, y confirma los beneficios tributarios con un asesor.

---

## Configuración (`.env.example`)

| Variable | Uso |
|---|---|
| `API_KEYS` | `clave:etiqueta,clave2:etiqueta2`. **Obligatoria en producción** (sin ella la API responde 500 `misconfigured`). |
| `RATE_LIMIT_PER_MINUTE` | Unidades por minuto por clave (por defecto 60). |
| `CORS_ORIGINS` | Orígenes de navegador permitidos (vacío = solo servidor a servidor). |
| `DEMO_ENABLED`, `DEMO_RATE_LIMIT_PER_MINUTE` | Demo pública (Server Actions) con límite por IP. |
| `IRRADIANCE_PROVIDERS` | Orden de proveedores de irradiancia. |
| `UPSTREAM_USER_AGENT` | Identificación con contacto, como piden Overpass y Nominatim. |
| `OVERPASS_URL`, `NOMINATIM_URL` | Instancias propias para volumen alto. |
| `GOOGLE_SOLAR_API_KEY` | Opcional, para países con cobertura de Google. |
| `MAX_PROSPECT_AREA_KM2`, `MAX_ROOF_AREA_M2`, `MAX_PANELS` | Límites de protección. |

---

## Despliegue

- **Vercel**: importa el repositorio, define `API_KEYS` y `UPSTREAM_USER_AGENT` y despliega. Con Fluid Compute, las cachés LRU y el rate limit en memoria se comparten entre solicitudes concurrentes.
- **Docker**: `docker build -t techo-solar-api . && docker run -p 3000:3000 --env-file .env.local techo-solar-api`. La imagen usa la salida standalone e incluye healthcheck. El Dockerfile no se probó en este entorno.
- **Escala**: para varias instancias, mueve el rate limit y la caché a Redis (por ejemplo, Upstash) con la misma interfaz (`src/lib/api/rate-limit.ts`, `src/lib/api/cache.ts`). Para mucho volumen de prospección, usa tu propia instancia de Overpass.

---

## Datos y licencias

- **OpenStreetMap** (huellas, etiquetas, Nominatim): licencia ODbL. Muestra "© colaboradores de OpenStreetMap" donde uses estos datos; la API incluye el campo `attribution`. La cobertura de edificios en Ecuador es buena en zonas urbanas centrales y desigual en periferias. Cuando falta un edificio, envía el polígono en `roof`.
- **PVGIS** (Comisión Europea) y **NASA POWER**: datos públicos y gratuitos.
- **Teselas del mapa demo**: Esri World Imagery y OSM tiles. Para uso comercial en producción, usa un proveedor con licencia (Esri con API key, Mapbox, MapTiler…).

---

## Buenas prácticas aplicadas (skill de Vercel)

| Regla | Dónde |
|---|---|
| `async-api-routes`, `async-parallel` | `building-insights` arranca irradiancia, OSM y Google a la vez; `prospecting` usa `Promise.all` |
| `async-cheap-condition-before-await`, `async-defer-await` | Auth, rate limit y límites de área antes de llamar proveedores; `production` no consulta irradiancia si el cliente trae sus datos |
| `server-cache-lru` | Caché de promesas con deduplicación en vuelo (`src/lib/api/cache.ts`) |
| `server-after-nonblocking` | Log de uso con `after()` (`src/lib/api/handler.ts`) |
| `server-hoist-static-io` | OpenAPI, HTML de `/docs` y tarifas se construyen una vez por proceso |
| `server-auth-actions`, `server-serialization` | Server Actions de la demo con validación zod, rate limit por IP, interruptor `DEMO_ENABLED` y respuestas compactas |
| `server-no-shared-module-state` | El estado de módulo se limita a cachés indexadas y configuración |
| `bundle-dynamic-imports`, `bundle-conditional`, `bundle-barrel-imports` | Leaflet con `next/dynamic` y `ssr:false`; exportador CSV bajo demanda; `optimizePackageImports` para react-leaflet |
| `rerender-memo`, `rerender-defer-reads`, `rerender-use-ref-transient-values` | Capas del mapa memoizadas; inputs no controlados con refs; límites del mapa en una ref |
| `rendering-activity`, `rendering-usetransition-loading`, `rendering-content-visibility`, `rendering-conditional-render` | Pestañas con `<Activity>`, `useTransition`, lista de leads con `content-visibility` y ternarios en el JSX |
| `js-hoist-regexp`, `js-set-map-lookups`, `js-tosorted-immutable`, `js-early-exit` | Regex a nivel de módulo, `Set`/`Map` para tipos de edificio y filas, `toSorted()` y filtros baratos primero |

---

## Estructura

```
src/
  app/
    api/v1/…/route.ts        endpoints
    actions.ts               Server Actions de la demo
    docs/route.ts            referencia interactiva (Scalar)
    page.tsx                 demo con mapa
  components/                explorer (UI) y solar-map (Leaflet)
  lib/
    api/                     handler común, auth, rate limit, caché, errores RFC 9457, fetch
    geo/                     geometría y distribución de paneles
    solar/                   irradiancia en el plano, producción, catálogo de paneles
    finance/                 tarifas Ecuador y análisis financiero
    providers/               PVGIS, NASA POWER, Overpass/Nominatim, Google Solar
    services/                building-insights, prospección, propuesta, exportación CSV
    schemas.ts               validación zod (también genera el OpenAPI)
tests/                       vitest
```
