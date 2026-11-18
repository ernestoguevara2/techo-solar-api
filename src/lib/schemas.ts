import { z } from "zod";

/**
 * Schemas de entrada compartidos. Se usan para validar (422 con detalle por campo)
 * y para generar el documento OpenAPI (z.toJSONSchema), así la documentación
 * nunca se desincroniza del código.
 */

z.config(z.locales.es());

export const latLngSchema = z
  .object({
    lat: z.number().min(-90).max(90).describe("Latitud en grados decimales (WGS84)"),
    lng: z.number().min(-180).max(180).describe("Longitud en grados decimales (WGS84)"),
  })
  .describe("Coordenadas del punto");

const positionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const polygonSchema = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(positionSchema).min(4).max(2_000)).min(1).max(50),
  })
  .describe("Polígono GeoJSON (posiciones [lng, lat]); el primer anillo es el contorno y los demás son huecos");

export const panelSchema = z
  .object({
    id: z.string().max(64).optional().describe("Id del catálogo (generico-580w, generico-440w)"),
    capacityWatts: z.number().min(100).max(1_000).optional(),
    widthM: z.number().min(0.5).max(2).optional().describe("Lado corto del panel (m)"),
    heightM: z.number().min(0.8).max(3).optional().describe("Lado largo del panel (m)"),
    tempCoefficientPctPerC: z.number().min(-1).max(0).optional(),
  })
  .describe("Panel a usar; por defecto genérico de 580 W");

export const lossesSchema = z
  .object({
    soiling: z.number().min(0).max(100),
    shading: z.number().min(0).max(100),
    snow: z.number().min(0).max(100),
    mismatch: z.number().min(0).max(100),
    wiring: z.number().min(0).max(100),
    connections: z.number().min(0).max(100),
    lightInducedDegradation: z.number().min(0).max(100),
    nameplateRating: z.number().min(0).max(100),
    age: z.number().min(0).max(100),
    availability: z.number().min(0).max(100),
  })
  .partial()
  .describe("Desglose de pérdidas (%) estilo PVWatts; total por defecto ≈ 14 %");

export const tariffCategorySchema = z.enum(["residencial", "comercial", "industrial"]);
export const regionSchema = z.enum(["sierra", "costa", "oriente", "galapagos"]);
export const irradianceSourceSchema = z.enum(["pvgis-nsrdb", "pvgis-era5", "nasa-power", "clear-sky"]);

export const consumptionSchema = z
  .object({
    monthlyKwh: z
      .union([z.number().positive().max(1e8), z.array(z.number().min(0).max(1e8)).length(12)])
      .optional()
      .describe("Consumo mensual en kWh: un valor promedio o 12 valores (enero a diciembre)"),
    monthlyBillUsd: z.number().positive().max(1e8).optional().describe("Planilla mensual promedio en USD"),
    tariffCategory: tariffCategorySchema.default("comercial"),
    region: regionSchema.optional(),
    tariffUsdPerKwh: z.number().positive().max(2).optional().describe("Sobrescribe la tarifa referencial"),
  })
  .refine((c) => c.monthlyKwh !== undefined || c.monthlyBillUsd !== undefined, {
    message: "Envía monthlyKwh o monthlyBillUsd",
  });

export const financeOptionsSchema = z
  .object({
    systemCostUsd: z.number().positive().max(1e9).optional(),
    costPerWpUsd: z.number().positive().max(10).optional(),
    discountRatePercent: z.number().min(0).max(50).optional(),
    analysisYears: z.number().int().min(1).max(40).optional(),
    tariffEscalationPercentPerYear: z.number().min(-10).max(30).optional(),
    degradationPercentPerYear: z.number().min(0).max(5).optional(),
    omCostPercentOfCapexPerYear: z.number().min(0).max(20).optional(),
    inverterReplacementYear: z.number().int().min(1).max(40).nullable().optional(),
    netMetering: z.enum(["monthly_balance", "self_consumption"]).optional(),
    selfConsumptionRatio: z.number().min(0).max(1).optional(),
    creditResetMonths: z.number().int().min(0).max(120).optional(),
    entityType: z.enum(["persona_natural", "empresa"]).optional(),
    incomeTaxPercent: z.number().min(0).max(60).optional(),
    acceleratedDepreciation: z.boolean().optional(),
    depreciationYears: z.number().int().min(1).max(40).optional(),
    emissionFactorKgPerKwh: z.number().min(0).max(2).optional(),
    loan: z
      .object({
        downPaymentPercent: z.number().min(0).max(100).default(20),
        interestRatePercent: z.number().min(0).max(50),
        termYears: z.number().int().min(1).max(30),
      })
      .optional(),
  })
  .describe("Supuestos financieros; todos opcionales");

export const layoutOptionsSchema = z
  .object({
    orientation: z.enum(["portrait", "landscape", "auto"]).default("auto"),
    mounting: z.enum(["flush", "tilted_rack"]).optional(),
    tiltDegrees: z.number().min(0).max(60).optional(),
    setbackM: z.number().min(0).max(10).optional().describe("Retiro perimetral (m)"),
    colGapM: z.number().min(0).max(2).default(0.02),
    rowGapM: z.number().min(0).max(10).optional().describe("Separación entre filas; si falta se calcula para evitar sombras"),
    azimuthDegrees: z.number().min(0).max(360).optional().describe("Hacia dónde miran los paneles (0 = norte)"),
    obstructions: z.array(polygonSchema).max(500).optional().describe("Zonas de exclusión: tragaluces, equipos de A/C, tanques"),
    obstructionBufferM: z.number().min(0).max(10).default(0.5),
    designSunElevationDegrees: z.number().min(5).max(80).default(25),
  })
  .partial()
  .describe("Opciones de distribución de paneles");

export const productionRequestSchema = z.object({
  location: latLngSchema,
  capacityKwp: z.number().positive().max(100_000),
  tiltDegrees: z.number().min(0).max(90).default(10),
  azimuthDegrees: z.number().min(0).max(360).optional().describe("Por defecto mira al ecuador"),
  moduleType: z.enum(["standard", "premium", "thin_film"]).default("premium"),
  arrayType: z.enum(["fixed_open_rack", "fixed_roof_mount"]).default("fixed_roof_mount"),
  systemLossesPercent: z.number().min(0).max(99).optional(),
  losses: lossesSchema.optional(),
  inverterEfficiencyPercent: z.number().min(80).max(99.5).default(96),
  degradationPercentPerYear: z.number().min(0).max(5).default(0.5),
  years: z.number().int().min(1).max(40).default(25),
  albedo: z.number().min(0).max(1).default(0.2),
  irradianceSource: irradianceSourceSchema.optional(),
  monthlyGhiKwhM2Day: z
    .array(z.number().min(0).max(12))
    .length(12)
    .optional()
    .describe("Si tienes datos medidos propios, envíalos y no se consulta ningún proveedor"),
  monthlyTempC: z.array(z.number().min(-30).max(50)).length(12).optional(),
});

export const solarResourceQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  source: irradianceSourceSchema.optional(),
});

export const layoutRequestSchema = z.object({
  roof: polygonSchema,
  panel: panelSchema.optional(),
  layout: layoutOptionsSchema.optional(),
  includeGeometry: z.boolean().default(true),
});

export const buildingInsightsBaseSchema = z.object({
    location: latLngSchema.optional(),
    roof: polygonSchema.optional().describe("Si ya tienes el contorno del techo, envíalo y se omite la búsqueda en mapas"),
    source: z.enum(["auto", "openstreetmap", "google"]).default("auto"),
    searchRadiusM: z.number().min(5).max(100).default(30),
    roofType: z.enum(["auto", "flat", "pitched"]).default("auto"),
    pitchDegrees: z.number().min(0).max(60).optional(),
    roofAzimuthDegrees: z.number().min(0).max(360).optional().describe("Techo inclinado de una sola agua: hacia dónde cae"),
    panel: panelSchema.optional(),
    layout: layoutOptionsSchema.optional(),
    includeLayout: z.boolean().default(false).describe("Incluye la geometría de cada panel (GeoJSON)"),
    systemLossesPercent: z.number().min(0).max(99).optional(),
    irradianceSource: irradianceSourceSchema.optional(),
    panelConfigsCount: z.number().int().min(1).max(50).default(10),
    consumption: consumptionSchema.optional(),
    targetOffsetPercent: z.number().min(10).max(150).default(100),
    finance: financeOptionsSchema.optional(),
  });

export const buildingInsightsSchema = buildingInsightsBaseSchema.refine((v) => v.location || v.roof, {
  message: "Envía location o roof",
});

export const batchBuildingInsightsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().max(128).optional(),
        location: latLngSchema.optional(),
        roof: polygonSchema.optional(),
      }),
    )
    .min(1)
    .max(25),
  defaults: buildingInsightsBaseSchema.omit({ location: true, roof: true }).partial().optional(),
});

export const financialAnalysisSchema = z.object({
  capacityKwp: z.number().positive().max(100_000),
  monthlyProductionKwh: z
    .union([z.number().min(0), z.array(z.number().min(0)).length(12)])
    .optional()
    .describe("Producción AC mensual; si falta, se calcula con location"),
  location: latLngSchema.optional(),
  tiltDegrees: z.number().min(0).max(90).default(10),
  azimuthDegrees: z.number().min(0).max(360).optional(),
  consumption: consumptionSchema,
  finance: financeOptionsSchema.optional(),
}).refine((v) => v.monthlyProductionKwh !== undefined || v.location, {
  message: "Envía monthlyProductionKwh o location",
});

export const bboxSchema = z
  .object({
    south: z.number().min(-90).max(90),
    west: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
  })
  .refine((b) => b.north > b.south && b.east > b.west, { message: "north > south y east > west" });

export const prospectingSchema = z
  .object({
    bbox: bboxSchema.optional(),
    center: latLngSchema.optional(),
    radiusM: z.number().min(50).max(3_000).optional(),
    minRoofAreaM2: z.number().min(20).max(1e6).default(300),
    buildingTypes: z.array(z.string().max(40)).max(30).optional().describe("Filtra por etiqueta building=* de OSM"),
    excludeResidential: z.boolean().default(false),
    excludeExistingSolar: z.boolean().default(true),
    sortBy: z.enum(["score", "area", "kwp"]).default("score"),
    limit: z.number().int().min(1).max(500).default(50),
    cursor: z.string().max(64).optional(),
    format: z.enum(["json", "geojson", "csv"]).default("json"),
    includeGeometry: z.boolean().default(false),
    panel: panelSchema.optional(),
    tariffUsdPerKwh: z.number().positive().max(2).optional(),
  })
  .refine((v) => v.bbox || (v.center && v.radiusM), { message: "Envía bbox, o center + radiusM" });

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color hexadecimal #RRGGBB");

export const proposalSchema = z.object({
  insights: buildingInsightsSchema,
  customer: z.object({
    name: z.string().min(1).max(120),
    address: z.string().max(240).optional(),
    email: z.string().email().max(160).optional(),
    phone: z.string().max(40).optional(),
  }),
  installer: z.object({
    name: z.string().min(1).max(120),
    logoUrl: z.string().url().max(500).refine((u) => u.startsWith("https://"), "Debe ser https").optional(),
    primaryColor: hexColor.optional(),
    phone: z.string().max(40).optional(),
    email: z.string().email().max(160).optional(),
    website: z.string().url().max(200).optional(),
  }),
  validityDays: z.number().int().min(1).max(180).default(15),
  notes: z.string().max(2_000).optional(),
  format: z.enum(["html", "json"]).default("html"),
});

export const geocodeQuerySchema = z.object({
  q: z.string().min(3).max(200),
  country: z
    .string()
    .regex(/^[a-z]{2}(,[a-z]{2})*$/)
    .default("ec"),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export type BuildingInsightsInput = z.output<typeof buildingInsightsSchema>;
export type ConsumptionInput = z.output<typeof consumptionSchema>;
export type FinanceOptionsInput = z.output<typeof financeOptionsSchema>;
export type LayoutOptionsInput = z.output<typeof layoutOptionsSchema>;
export type PanelInput = z.output<typeof panelSchema>;
export type ProspectingInput = z.output<typeof prospectingSchema>;
export type ProposalInput = z.output<typeof proposalSchema>;
