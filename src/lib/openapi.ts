import { z } from "zod";
import {
  batchBuildingInsightsSchema,
  buildingInsightsSchema,
  financialAnalysisSchema,
  layoutRequestSchema,
  productionRequestSchema,
  proposalSchema,
  prospectingSchema,
} from "./schemas";

/**
 * Documento OpenAPI 3.1 generado desde los mismos schemas zod que validan las
 * solicitudes. Se construye una sola vez por proceso (server-hoist-static-io).
 */

function schema(s: z.ZodType) {
  return z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
}

const problem = {
  description: "Error (RFC 9457)",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/Problem" },
    },
  },
};

const errors = {
  "401": problem,
  "413": problem,
  "415": problem,
  "422": problem,
  "429": problem,
  "500": problem,
  "503": problem,
};

function post(summary: string, description: string, body: z.ZodType, example: unknown, tag: string) {
  return {
    post: {
      tags: [tag],
      summary,
      description,
      security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: schema(body), example } },
      },
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } }, ...errors },
    },
  };
}

const QUITO = { lat: -0.1807, lng: -78.4678 };
const GYE_ROOF = {
  type: "Polygon",
  coordinates: [
    [
      [-79.9005, -2.1702],
      [-79.9001, -2.1702],
      [-79.9001, -2.1706],
      [-79.9005, -2.1706],
      [-79.9005, -2.1702],
    ],
  ],
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Techo Solar API",
    version: "1.0.0",
    description:
      "API de análisis solar de techos para empresas instaladoras en Ecuador: potencial por edificio, distribución de paneles, producción mensual, análisis financiero con tarifas y beneficios de Ecuador, prospección de clientes y propuestas con marca propia.\n\n" +
      "**Autenticación:** `Authorization: Bearer <API_KEY>` o `X-API-Key: <API_KEY>`.\n\n" +
      "**Errores:** formato RFC 9457 (`application/problem+json`) con `requestId` para soporte.\n\n" +
      "**Rate limit:** cabeceras `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; cada endpoint consume las unidades indicadas en su descripción.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "Edificios", description: "Potencial solar por techo" },
    { name: "Diseño", description: "Distribución de paneles y producción" },
    { name: "Finanzas", description: "Ahorro, retorno y financiamiento" },
    { name: "Prospección", description: "Generación de clientes potenciales" },
    { name: "Ventas", description: "Propuestas comerciales" },
    { name: "Datos", description: "Recurso solar, geocodificación y catálogos" },
    { name: "Sistema" },
  ],
  paths: {
    "/api/v1/building-insights": post(
      "Potencial solar de un edificio",
      "Busca la huella del edificio (OpenStreetMap o el polígono enviado), distribuye paneles, estima la producción mensual y, si envías el consumo, recomienda el tamaño y calcula el análisis financiero. Consume 3 unidades.",
      buildingInsightsSchema,
      { location: QUITO, consumption: { monthlyBillUsd: 450, tariffCategory: "comercial" }, includeLayout: false },
      "Edificios",
    ),
    "/api/v1/building-insights/batch": post(
      "Potencial solar de hasta 25 edificios",
      "Procesa una lista de puntos o polígonos en paralelo; cada ítem responde por separado. Consume 10 unidades.",
      batchBuildingInsightsSchema,
      { items: [{ id: "cliente-1", location: QUITO }, { id: "cliente-2", roof: GYE_ROOF }], defaults: { panelConfigsCount: 5 } },
      "Edificios",
    ),
    "/api/v1/panel-layout": post(
      "Distribución automática de paneles",
      "Coloca paneles sobre un polígono respetando retiros, obstrucciones y separación entre filas; devuelve cada panel como GeoJSON. Consume 2 unidades.",
      layoutRequestSchema,
      { roof: GYE_ROOF, layout: { setbackM: 1, mounting: "tilted_rack", tiltDegrees: 10 } },
      "Diseño",
    ),
    "/api/v1/production": post(
      "Producción estimada (tipo PVWatts)",
      "kWh AC mensuales y anuales, rendimiento específico, factor de planta, pérdidas y degradación a N años. Consume 1 unidad.",
      productionRequestSchema,
      { location: QUITO, capacityKwp: 50, tiltDegrees: 10 },
      "Diseño",
    ),
    "/api/v1/financial-analysis": post(
      "Análisis financiero (Ecuador)",
      "Balance neto mensual, Tarifa Dignidad, doble depreciación, VAN, TIR, payback, LCOE, CO₂ evitado y escenario con crédito. Consume 1 unidad.",
      financialAnalysisSchema,
      {
        capacityKwp: 30,
        location: QUITO,
        consumption: { monthlyKwh: 4200, tariffCategory: "comercial" },
        finance: { loan: { downPaymentPercent: 20, interestRatePercent: 11, termYears: 5 } },
      },
      "Finanzas",
    ),
    "/api/v1/prospecting/search": post(
      "Buscar clientes potenciales en una zona",
      "Escanea los edificios de una zona (máx. 4 km²), estima kWp y ahorro por techo y los ordena por puntaje comercial. Formatos json, geojson o csv. Consume 10 unidades.",
      prospectingSchema,
      { center: { lat: -2.1894, lng: -79.8891 }, radiusM: 800, minRoofAreaM2: 800, excludeResidential: true, limit: 20 },
      "Prospección",
    ),
    "/api/v1/proposals": post(
      "Propuesta comercial con marca propia",
      "Genera una propuesta en HTML lista para imprimir/guardar como PDF (o JSON con el HTML). Consume 4 unidades.",
      proposalSchema,
      {
        insights: { location: QUITO, consumption: { monthlyBillUsd: 450, tariffCategory: "comercial" } },
        customer: { name: "Panadería La Espiga" },
        installer: { name: "Solar Andes", primaryColor: "#b45309", phone: "+593 99 000 0000" },
      },
      "Ventas",
    ),
    "/api/v1/solar-resource": {
      get: {
        tags: ["Datos"],
        summary: "Recurso solar mensual",
        description: "GHI y temperatura mensual (PVGIS-NSRDB → NASA POWER → PVGIS-ERA5 → cielo despejado). Consume 1 unidad.",
        security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
        parameters: [
          { name: "lat", in: "query", required: true, schema: { type: "number", minimum: -90, maximum: 90 }, example: QUITO.lat },
          { name: "lng", in: "query", required: true, schema: { type: "number", minimum: -180, maximum: 180 }, example: QUITO.lng },
          { name: "source", in: "query", schema: { type: "string", enum: ["pvgis-nsrdb", "pvgis-era5", "nasa-power", "clear-sky"] } },
        ],
        responses: { "200": { description: "OK" }, ...errors },
      },
    },
    "/api/v1/geocode": {
      get: {
        tags: ["Datos"],
        summary: "Dirección → coordenadas",
        security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 3 }, example: "Parque La Carolina, Quito" },
          { name: "country", in: "query", schema: { type: "string", default: "ec" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 5, maximum: 10 } },
        ],
        responses: { "200": { description: "OK" }, ...errors },
      },
    },
    "/api/v1/tariffs": {
      get: {
        tags: ["Datos"],
        summary: "Supuestos tarifarios y tributarios de Ecuador",
        security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
        responses: { "200": { description: "OK" }, ...errors },
      },
    },
    "/api/v1/panels": {
      get: {
        tags: ["Datos"],
        summary: "Catálogo de paneles",
        security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
        responses: { "200": { description: "OK" }, ...errors },
      },
    },
    "/api/v1/health": {
      get: { tags: ["Sistema"], summary: "Estado del servicio", security: [], responses: { "200": { description: "OK" } } },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
    schemas: {
      Problem: {
        type: "object",
        required: ["type", "title", "status"],
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          status: { type: "integer" },
          detail: { type: "string" },
          instance: { type: "string" },
          requestId: { type: "string" },
          errors: {
            type: "array",
            items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } },
          },
        },
      },
    },
  },
} as const;
