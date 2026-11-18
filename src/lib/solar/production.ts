import { DAYS_IN_MONTH, monthlyPlaneOfArray, type PlaneSpec } from "./irradiance";

/**
 * Estimación de producción tipo PVWatts: kWh AC mensuales para un sistema FV.
 * Entradas de recurso solar: GHI diaria promedio por mes y temperatura media mensual.
 */

export type ModuleType = "standard" | "premium" | "thin_film";
export type ArrayType = "fixed_open_rack" | "fixed_roof_mount";

/** Desglose de pérdidas por defecto, igual al de PVWatts (total ≈ 14,08 %). */
export const DEFAULT_LOSSES = {
  soiling: 2,
  shading: 3,
  snow: 0,
  mismatch: 2,
  wiring: 2,
  connections: 0.5,
  lightInducedDegradation: 1.5,
  nameplateRating: 1,
  age: 0,
  availability: 3,
} as const;

export type LossBreakdown = Record<keyof typeof DEFAULT_LOSSES, number>;

export function totalLossPercent(losses: Partial<LossBreakdown> = {}): number {
  const merged = { ...DEFAULT_LOSSES, ...losses };
  const remaining = Object.values(merged).reduce((acc, pct) => acc * (1 - pct / 100), 1);
  return (1 - remaining) * 100;
}

const TEMP_COEFF: Record<ModuleType, number> = {
  standard: -0.37,
  premium: -0.3,
  thin_film: -0.2,
};

/** Temperatura de operación nominal de celda (°C) según el montaje. */
const NOCT: Record<ArrayType, number> = {
  fixed_open_rack: 45,
  fixed_roof_mount: 50,
};

export interface ProductionInput {
  latitude: number;
  monthlyGhiDaily: readonly number[];
  monthlyTempC: readonly number[];
  capacityKwp: number;
  planes: (PlaneSpec & { weight?: number })[];
  moduleType?: ModuleType;
  tempCoefficientPctPerC?: number;
  arrayType?: ArrayType;
  /** Pérdidas totales del sistema (%). Si falta se usa el desglose. */
  systemLossesPercent?: number;
  losses?: Partial<LossBreakdown>;
  inverterEfficiencyPercent?: number;
  degradationPercentPerYear?: number;
  years?: number;
}

export interface ProductionResult {
  capacityKwp: number;
  monthlyAcKwh: number[];
  monthlyDcKwh: number[];
  monthlyPoaKwhM2: number[];
  /** Irradiación global horizontal mensual (kWh/m²). Equivale a solrad de PVWatts × días. */
  monthlyGhiKwhM2: number[];
  annualAcKwh: number;
  annualDcKwh: number;
  annualPoaKwhM2: number;
  /** kWh/kWp/año (también llamado "horas solares pico" anuales). */
  specificYieldKwhPerKwp: number;
  capacityFactorPercent: number;
  performanceRatio: number;
  systemLossesPercent: number;
  temperatureLossPercent: number;
  inverterEfficiencyPercent: number;
  lifetime: { year: number; acKwh: number }[];
  lifetimeAcKwh: number;
}

export function estimateProduction(input: ProductionInput): ProductionResult {
  const gammaPct = input.tempCoefficientPctPerC ?? TEMP_COEFF[input.moduleType ?? "standard"];
  const noct = NOCT[input.arrayType ?? "fixed_roof_mount"];
  const lossesPct = input.systemLossesPercent ?? totalLossPercent(input.losses);
  const invEff = (input.inverterEfficiencyPercent ?? 96) / 100;
  const deg = (input.degradationPercentPerYear ?? 0.5) / 100;
  const years = input.years ?? 25;

  const totalWeight = input.planes.reduce((s, p) => s + (p.weight ?? 1), 0);

  const monthlyPoa = new Array(12).fill(0);
  const monthlyDcPerKwp = new Array(12).fill(0);
  let tempLossNum = 0;
  let tempLossDen = 0;

  for (const plane of input.planes) {
    const w = (plane.weight ?? 1) / totalWeight;
    const poa = monthlyPlaneOfArray(input.latitude, input.monthlyGhiDaily, plane);
    for (let m = 0; m < 12; m++) {
      // Temperatura diurna ≈ media mensual + 3 °C (la media incluye la noche).
      const tAmbDay = input.monthlyTempC[m] + 3;
      let energy = 0;
      let energyTempCorrected = 0;
      for (const step of poa.profiles[m]) {
        const g = step.irradianceWm2;
        const tCell = tAmbDay + ((noct - 20) / 800) * g;
        const factor = 1 + (gammaPct / 100) * (tCell - 25);
        const e = (g / 1000) * step.hours;
        energy += e;
        energyTempCorrected += e * factor;
      }
      const days = DAYS_IN_MONTH[m];
      monthlyPoa[m] += w * poa.poaDaily[m] * days;
      monthlyDcPerKwp[m] += w * energyTempCorrected * days * (1 - lossesPct / 100);
      tempLossNum += w * (energy - energyTempCorrected) * days;
      tempLossDen += w * energy * days;
    }
  }

  const monthlyDc = monthlyDcPerKwp.map((v) => v * input.capacityKwp);
  const monthlyAc = monthlyDc.map((v) => v * invEff);
  const monthlyGhi = input.monthlyGhiDaily.map((v, m) => v * DAYS_IN_MONTH[m]);
  const annualAc = sum(monthlyAc);
  const annualDc = sum(monthlyDc);
  const annualPoa = sum(monthlyPoa);
  const specific = input.capacityKwp > 0 ? annualAc / input.capacityKwp : 0;

  const lifetime = Array.from({ length: years }, (_, i) => ({
    year: i + 1,
    acKwh: round(annualAc * (1 - deg) ** i, 1),
  }));

  return {
    capacityKwp: input.capacityKwp,
    monthlyAcKwh: monthlyAc.map((v) => round(v, 1)),
    monthlyDcKwh: monthlyDc.map((v) => round(v, 1)),
    monthlyPoaKwhM2: monthlyPoa.map((v) => round(v, 2)),
    monthlyGhiKwhM2: monthlyGhi.map((v) => round(v, 2)),
    annualAcKwh: round(annualAc, 1),
    annualDcKwh: round(annualDc, 1),
    annualPoaKwhM2: round(annualPoa, 1),
    specificYieldKwhPerKwp: round(specific, 1),
    capacityFactorPercent: round((specific / 8760) * 100, 2),
    performanceRatio: annualPoa > 0 ? round(specific / annualPoa, 3) : 0,
    systemLossesPercent: round(lossesPct, 2),
    temperatureLossPercent: tempLossDen > 0 ? round((tempLossNum / tempLossDen) * 100, 2) : 0,
    inverterEfficiencyPercent: invEff * 100,
    lifetime,
    lifetimeAcKwh: round(lifetime.reduce((s, y) => s + y.acKwh, 0), 0),
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
