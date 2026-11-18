import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { analyzeFinance } from "@/lib/finance/analysis";
import { getSolarResource } from "@/lib/providers/irradiance";
import { financialAnalysisSchema } from "@/lib/schemas";
import { consumptionToMonthlyKwh } from "@/lib/services/building-insights";
import { estimateProduction } from "@/lib/solar/production";

/** POST /api/v1/financial-analysis — ahorro, VAN, TIR, payback, LCOE y crédito con reglas de Ecuador. */
export const POST = apiRoute({ cost: 1 }, async (ctx) => {
  const body = await ctx.body(financialAnalysisSchema);

  let monthlyProduction: number[];
  let productionSource: string;
  if (body.monthlyProductionKwh !== undefined) {
    monthlyProduction = Array.isArray(body.monthlyProductionKwh)
      ? body.monthlyProductionKwh
      : new Array(12).fill(body.monthlyProductionKwh);
    productionSource = "user";
  } else {
    const { lat, lng } = body.location!;
    const resource = await getSolarResource(lat, lng);
    const prod = estimateProduction({
      latitude: lat,
      monthlyGhiDaily: resource.monthlyGhiKwhM2Day,
      monthlyTempC: resource.monthlyTempC,
      capacityKwp: body.capacityKwp,
      planes: [{ tiltDegrees: body.tiltDegrees, azimuthDegrees: body.azimuthDegrees ?? (lat >= 0 ? 180 : 0) }],
      years: 1,
    });
    monthlyProduction = prod.monthlyAcKwh;
    productionSource = resource.source;
  }

  const result = analyzeFinance({
    capacityKwp: body.capacityKwp,
    monthlyProductionKwh: monthlyProduction,
    monthlyConsumptionKwh: consumptionToMonthlyKwh(body.consumption),
    tariffCategory: body.consumption.tariffCategory,
    region: body.consumption.region,
    tariffUsdPerKwh: body.consumption.tariffUsdPerKwh,
    ...body.finance,
  });

  return { productionSource, ...result };
});

export const OPTIONS = corsPreflight;
