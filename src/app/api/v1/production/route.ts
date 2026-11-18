import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { getSolarResource } from "@/lib/providers/irradiance";
import { productionRequestSchema } from "@/lib/schemas";
import { estimateProduction } from "@/lib/solar/production";

/** POST /api/v1/production — estimación de producción tipo PVWatts. */
export const POST = apiRoute({ cost: 1 }, async (ctx) => {
  const body = await ctx.body(productionRequestSchema);
  const { lat, lng } = body.location;

  // Si el cliente trae sus propios datos de irradiancia, no se consulta ningún proveedor (async-defer-await).
  const resource =
    body.monthlyGhiKwhM2Day && body.monthlyTempC
      ? null
      : await getSolarResource(lat, lng, { preferred: body.irradianceSource });

  const azimuth = body.azimuthDegrees ?? (lat >= 0 ? 180 : 0);
  const result = estimateProduction({
    latitude: lat,
    monthlyGhiDaily: body.monthlyGhiKwhM2Day ?? resource!.monthlyGhiKwhM2Day,
    monthlyTempC: body.monthlyTempC ?? resource!.monthlyTempC,
    capacityKwp: body.capacityKwp,
    planes: [{ tiltDegrees: body.tiltDegrees, azimuthDegrees: azimuth, albedo: body.albedo }],
    moduleType: body.moduleType,
    arrayType: body.arrayType,
    systemLossesPercent: body.systemLossesPercent,
    losses: body.losses,
    inverterEfficiencyPercent: body.inverterEfficiencyPercent,
    degradationPercentPerYear: body.degradationPercentPerYear,
    years: body.years,
  });

  return {
    inputs: { ...body, azimuthDegrees: azimuth },
    solarResource: resource
      ? { source: resource.source, quality: resource.quality, location: resource.location, elevationM: resource.elevationM }
      : { source: "user", quality: "high" },
    outputs: result,
  };
});

export const OPTIONS = corsPreflight;
