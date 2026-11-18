/**
 * Supuestos tarifarios y tributarios para Ecuador.
 *
 * IMPORTANTE: son valores REFERENCIALES para estimaciones comerciales. Antes de
 * presentar una propuesta firme, reemplázalos con el pliego tarifario vigente de
 * ARCONEL y la planilla real del cliente (cada request acepta `tariffUsdPerKwh`
 * y demás parámetros para sobrescribirlos).
 *
 * Se cargan una sola vez a nivel de módulo (regla server-hoist-static-io).
 */

export type TariffCategory = "residencial" | "comercial" | "industrial";
export type Region = "sierra" | "costa" | "oriente" | "galapagos";

export interface TariffInfo {
  category: TariffCategory;
  /** Precio de energía (USD/kWh) usado para valorar el ahorro. */
  energyUsdPerKwh: number;
  /** Costo instalado referencial (USD por Wp DC), incluye equipos, estructura e instalación. */
  installedCostUsdPerWp: number;
  note: string;
}

export const TARIFFS_EC: Readonly<Record<TariffCategory, TariffInfo>> = {
  residencial: {
    category: "residencial",
    energyUsdPerKwh: 0.1,
    installedCostUsdPerWp: 1.4,
    note: "Promedio nacional pagado ≈ 10,6 ¢/kWh (ARCONEL, costos 2026). Aplica Tarifa Dignidad a consumos bajos.",
  },
  comercial: {
    category: "comercial",
    energyUsdPerKwh: 0.092,
    installedCostUsdPerWp: 1.2,
    note: "Valor referencial de energía en baja tensión comercial; no incluye cargo por demanda (kW).",
  },
  industrial: {
    category: "industrial",
    energyUsdPerKwh: 0.085,
    installedCostUsdPerWp: 1.1,
    note: "Valor referencial de energía en media tensión; no incluye cargo por demanda (kW).",
  },
};

/** Tarifa Dignidad: hogares con consumo bajo pagan ≈ 4 ¢/kWh. */
export const TARIFA_DIGNIDAD = {
  usdPerKwh: 0.04,
  maxKwhPerMonth: { sierra: 110, oriente: 110, costa: 130, galapagos: 130 } as Record<Region, number>,
  note: "Hasta 110 kWh/mes en la Sierra y 130 kWh/mes en la Costa (referencia periodística, verificar pliego).",
};

export const TAX_EC = {
  /** Impuesto a la renta de sociedades (%). */
  corporateIncomeTaxPercent: 25,
  /** IVA sobre paneles y accesorios fotovoltaicos (%): 0 % según la Ley Orgánica de Competitividad Energética. */
  vatOnSolarEquipmentPercent: 0,
  /** Años de depreciación contable del sistema. */
  depreciationYears: 10,
  /** Deducción adicional del 100 % de la depreciación ("doble depreciación") para empresas. */
  acceleratedDepreciationEligible: true,
  note:
    "Beneficios tributarios referenciales (LOCE 2024 y reformas): IVA 0 % en equipos FV y deducción adicional por depreciación. Confirmar con un asesor tributario.",
};

/** Factor de emisión de la red (kg CO2/kWh). Supuesto editable: reemplazar por el factor oficial publicado por CENACE/MEM. */
export const GRID_EMISSION_FACTOR_KG_PER_KWH = 0.3;

export const FINANCE_DEFAULTS = {
  discountRatePercent: 9,
  analysisYears: 25,
  degradationPercentPerYear: 0.5,
  omCostPercentOfCapexPerYear: 1,
  tariffEscalationPercentPerYear: 0,
  inverterReplacementYear: 12,
  inverterReplacementUsdPerWp: 0.08,
};

export function tariffFor(category: TariffCategory): TariffInfo {
  return TARIFFS_EC[category];
}

/**
 * Factura mensual de energía (sin cargos fijos ni demanda).
 * En residencial aplica la Tarifa Dignidad si el consumo neto no supera el umbral regional.
 */
export function monthlyEnergyBill(
  netKwh: number,
  category: TariffCategory,
  options: { region?: Region; tariffUsdPerKwh?: number; applyDignidad?: boolean } = {},
): number {
  const kwh = Math.max(0, netKwh);
  if (category === "residencial" && options.applyDignidad !== false && options.tariffUsdPerKwh === undefined) {
    const threshold = TARIFA_DIGNIDAD.maxKwhPerMonth[options.region ?? "sierra"];
    if (kwh <= threshold) return kwh * TARIFA_DIGNIDAD.usdPerKwh;
  }
  return kwh * (options.tariffUsdPerKwh ?? TARIFFS_EC[category].energyUsdPerKwh);
}
