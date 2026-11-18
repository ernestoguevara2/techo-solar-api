import {
  FINANCE_DEFAULTS,
  GRID_EMISSION_FACTOR_KG_PER_KWH,
  monthlyEnergyBill,
  TAX_EC,
  TARIFFS_EC,
  type Region,
  type TariffCategory,
} from "./tariffs-ec";

/**
 * Análisis financiero de un sistema FV en Ecuador: ahorro mensual con balance
 * neto, flujo de caja a 25 años, VAN, TIR, payback, LCOE, beneficio tributario
 * y escenarios de pago (contado o crédito). Equivalente a los "financialAnalyses"
 * de Google Solar API, adaptado a la regulación ecuatoriana.
 */

export type NetMetering = "monthly_balance" | "self_consumption";
export type EntityType = "persona_natural" | "empresa";

export interface FinanceInput {
  capacityKwp: number;
  /** Producción AC del año 1 por mes (kWh). */
  monthlyProductionKwh: number[];
  /** Consumo mensual (kWh): un número (se repite 12 veces) o un arreglo de 12. */
  monthlyConsumptionKwh: number | number[];
  tariffCategory: TariffCategory;
  region?: Region;
  tariffUsdPerKwh?: number;
  tariffEscalationPercentPerYear?: number;
  /** Costo instalado total (USD). Si falta se usa costPerWpUsd × capacidad. */
  systemCostUsd?: number;
  costPerWpUsd?: number;
  netMetering?: NetMetering;
  /** Solo para self_consumption: fracción de la producción consumida al instante (0–1). */
  selfConsumptionRatio?: number;
  /** Meses que duran los créditos de energía antes de reiniciarse (monthly_balance). */
  creditResetMonths?: number;
  entityType?: EntityType;
  incomeTaxPercent?: number;
  acceleratedDepreciation?: boolean;
  depreciationYears?: number;
  discountRatePercent?: number;
  analysisYears?: number;
  degradationPercentPerYear?: number;
  omCostPercentOfCapexPerYear?: number;
  inverterReplacementYear?: number | null;
  inverterReplacementUsdPerWp?: number;
  emissionFactorKgPerKwh?: number;
  loan?: { downPaymentPercent: number; interestRatePercent: number; termYears: number };
}

export interface MonthRow {
  month: number;
  consumptionKwh: number;
  productionKwh: number;
  gridImportKwh: number;
  exportedKwh: number;
  creditUsedKwh: number;
  creditBalanceKwh: number;
  billBeforeUsd: number;
  billAfterUsd: number;
  savingsUsd: number;
}

export interface YearRow {
  year: number;
  productionKwh: number;
  savingsUsd: number;
  omCostUsd: number;
  replacementCostUsd: number;
  taxEffectUsd: number;
  loanPaymentUsd: number;
  netCashFlowUsd: number;
  cumulativeCashFlowUsd: number;
}

export interface FinanceResult {
  capexUsd: number;
  costPerWpUsd: number;
  annualConsumptionKwh: number;
  annualProductionKwh: number;
  billOffsetPercent: number;
  firstYear: {
    billBeforeUsd: number;
    billAfterUsd: number;
    savingsUsd: number;
    months: MonthRow[];
  };
  cash: {
    npvUsd: number;
    irrPercent: number | null;
    simplePaybackYears: number | null;
    discountedPaybackYears: number | null;
    roiPercent: number;
    lifetimeSavingsUsd: number;
    lcoeUsdPerKwh: number;
    cashFlows: YearRow[];
  };
  loan: null | {
    principalUsd: number;
    downPaymentUsd: number;
    monthlyPaymentUsd: number;
    totalInterestUsd: number;
    npvUsd: number;
    irrPercent: number | null;
    firstYearNetSavingsUsd: number;
    cashFlows: YearRow[];
  };
  environment: {
    co2AvoidedTonnesPerYear: number;
    co2AvoidedTonnesLifetime: number;
    treesEquivalent: number;
    emissionFactorKgPerKwh: number;
  };
  assumptions: Record<string, string | number | boolean | null>;
}

export function npv(ratePercent: number, flows: number[]): number {
  const r = ratePercent / 100;
  return flows.reduce((acc, f, t) => acc + f / (1 + r) ** t, 0);
}

/** TIR por bisección (robusta; los flujos FV tienen un solo cambio de signo). */
export function irr(flows: number[]): number | null {
  const f = (r: number) => flows.reduce((acc, v, t) => acc + v / (1 + r) ** t, 0);
  let lo = -0.99;
  let hi = 1;
  let fLo = f(lo);
  let fHi = f(hi);
  if (fLo * fHi > 0) {
    hi = 10;
    fHi = f(hi);
    if (fLo * fHi > 0) return null;
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < 1e-7) return mid * 100;
    if (fLo * fMid < 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return ((lo + hi) / 2) * 100;
}

/** Años (con decimales) hasta que el acumulado se vuelve positivo. flows[0] = inversión inicial (negativa). */
export function paybackYears(flows: number[]): number | null {
  let cumulative = flows[0];
  if (cumulative >= 0) return 0;
  for (let t = 1; t < flows.length; t++) {
    const next = cumulative + flows[t];
    if (next >= 0) return t - 1 + -cumulative / flows[t];
    cumulative = next;
  }
  return null;
}

export function loanPayment(principal: number, annualRatePercent: number, termYears: number): number {
  const n = termYears * 12;
  const i = annualRatePercent / 100 / 12;
  if (n <= 0) return 0;
  if (i === 0) return principal / n;
  return (principal * i) / (1 - (1 + i) ** -n);
}

function toTwelve(v: number | number[]): number[] {
  return Array.isArray(v) ? v.slice(0, 12) : new Array(12).fill(v);
}

/** Simula un año mes a mes con balance neto o solo autoconsumo. */
function simulateYear(
  production: number[],
  consumption: number[],
  input: FinanceInput,
  tariffMultiplier: number,
  startCredit: number,
  monthOffset: number,
): { months: MonthRow[]; endCredit: number } {
  const mode = input.netMetering ?? "monthly_balance";
  const reset = input.creditResetMonths ?? 12;
  const tariff = input.tariffUsdPerKwh;
  const opts = { region: input.region, tariffUsdPerKwh: tariff };
  let credit = startCredit;
  const months: MonthRow[] = [];

  for (let m = 0; m < 12; m++) {
    const absoluteMonth = monthOffset + m;
    if (reset > 0 && absoluteMonth > 0 && absoluteMonth % reset === 0) credit = 0;

    const cons = consumption[m];
    const prod = production[m];
    let gridImport: number;
    let exported: number;
    let creditUsed = 0;

    if (mode === "self_consumption") {
      const ratio = input.selfConsumptionRatio ?? 0.8;
      const selfUsed = Math.min(cons, prod * ratio);
      gridImport = cons - selfUsed;
      exported = prod - selfUsed;
    } else {
      const net = cons - prod;
      if (net >= 0) {
        creditUsed = Math.min(credit, net);
        credit -= creditUsed;
        gridImport = net - creditUsed;
        exported = 0;
      } else {
        gridImport = 0;
        exported = -net;
        credit += exported;
      }
    }

    const billBefore = monthlyEnergyBill(cons, input.tariffCategory, opts) * tariffMultiplier;
    const billAfter = monthlyEnergyBill(gridImport, input.tariffCategory, opts) * tariffMultiplier;
    months.push({
      month: m + 1,
      consumptionKwh: r1(cons),
      productionKwh: r1(prod),
      gridImportKwh: r1(gridImport),
      exportedKwh: r1(exported),
      creditUsedKwh: r1(creditUsed),
      creditBalanceKwh: r1(credit),
      billBeforeUsd: r2(billBefore),
      billAfterUsd: r2(billAfter),
      savingsUsd: r2(billBefore - billAfter),
    });
  }
  return { months, endCredit: credit };
}

export function analyzeFinance(input: FinanceInput): FinanceResult {
  const years = input.analysisYears ?? FINANCE_DEFAULTS.analysisYears;
  const deg = (input.degradationPercentPerYear ?? FINANCE_DEFAULTS.degradationPercentPerYear) / 100;
  const escalation = (input.tariffEscalationPercentPerYear ?? FINANCE_DEFAULTS.tariffEscalationPercentPerYear) / 100;
  const discount = input.discountRatePercent ?? FINANCE_DEFAULTS.discountRatePercent;
  const costPerWp = input.costPerWpUsd ?? TARIFFS_EC[input.tariffCategory].installedCostUsdPerWp;
  const capex = input.systemCostUsd ?? costPerWp * input.capacityKwp * 1000;
  const omPct = (input.omCostPercentOfCapexPerYear ?? FINANCE_DEFAULTS.omCostPercentOfCapexPerYear) / 100;
  const invYear = input.inverterReplacementYear === undefined ? FINANCE_DEFAULTS.inverterReplacementYear : input.inverterReplacementYear;
  const invCost =
    (input.inverterReplacementUsdPerWp ?? FINANCE_DEFAULTS.inverterReplacementUsdPerWp) * input.capacityKwp * 1000;
  const entity = input.entityType ?? (input.tariffCategory === "residencial" ? "persona_natural" : "empresa");
  const taxRate = (input.incomeTaxPercent ?? TAX_EC.corporateIncomeTaxPercent) / 100;
  const depYears = input.depreciationYears ?? TAX_EC.depreciationYears;
  const accelerated = entity === "empresa" && (input.acceleratedDepreciation ?? TAX_EC.acceleratedDepreciationEligible);
  const emission = input.emissionFactorKgPerKwh ?? GRID_EMISSION_FACTOR_KG_PER_KWH;

  const production1 = toTwelve(input.monthlyProductionKwh);
  const consumption = toTwelve(input.monthlyConsumptionKwh);
  const annualConsumption = consumption.reduce((a, b) => a + b, 0);
  const annualProduction = production1.reduce((a, b) => a + b, 0);

  // Ahorro de cada año (simulación mensual con degradación y escalamiento tarifario).
  const yearlySavings: number[] = [];
  const yearlyProduction: number[] = [];
  let credit = 0;
  let firstYearMonths: MonthRow[] = [];
  for (let y = 0; y < years; y++) {
    const factor = (1 - deg) ** y;
    const prod = production1.map((p) => p * factor);
    const sim = simulateYear(prod, consumption, input, (1 + escalation) ** y, credit, y * 12);
    credit = sim.endCredit;
    if (y === 0) firstYearMonths = sim.months;
    yearlySavings.push(sim.months.reduce((s, m) => s + m.savingsUsd, 0));
    yearlyProduction.push(prod.reduce((a, b) => a + b, 0));
  }

  const annualDepreciation = capex / depYears;

  function buildFlows(loan?: { down: number; annualPayment: number; term: number; interestByYear: number[] }) {
    const rows: YearRow[] = [];
    const flows: number[] = [loan ? -loan.down : -capex];
    let cumulative = flows[0];
    for (let y = 1; y <= years; y++) {
      const savings = yearlySavings[y - 1];
      const om = capex * omPct;
      const replacement = invYear && y === invYear ? invCost : 0;
      let tax = 0;
      if (entity === "empresa") {
        // El ahorro aumenta la utilidad gravable; O&M, depreciación (y la deducción adicional) la reducen.
        const dep = y <= depYears ? annualDepreciation : 0;
        const extraDep = accelerated && y <= depYears ? annualDepreciation : 0;
        const interest = loan ? (loan.interestByYear[y - 1] ?? 0) : 0;
        tax = -(savings - om - replacement - interest) * taxRate + (dep + extraDep) * taxRate;
      }
      const payment = loan && y <= loan.term ? loan.annualPayment : 0;
      const net = savings - om - replacement + tax - payment;
      cumulative += net;
      flows.push(net);
      rows.push({
        year: y,
        productionKwh: r1(yearlyProduction[y - 1]),
        savingsUsd: r2(savings),
        omCostUsd: r2(om),
        replacementCostUsd: r2(replacement),
        taxEffectUsd: r2(tax),
        loanPaymentUsd: r2(payment),
        netCashFlowUsd: r2(net),
        cumulativeCashFlowUsd: r2(cumulative),
      });
    }
    return { rows, flows };
  }

  const cash = buildFlows();
  const discountedFlows = cash.flows.map((f, t) => f / (1 + discount / 100) ** t);
  const totalOm = cash.rows.reduce((s, r) => s + r.omCostUsd + r.replacementCostUsd, 0);
  const discountedEnergy = yearlyProduction.reduce((s, e, i) => s + e / (1 + discount / 100) ** (i + 1), 0);
  const discountedCosts =
    capex +
    cash.rows.reduce((s, r, i) => s + (r.omCostUsd + r.replacementCostUsd) / (1 + discount / 100) ** (i + 1), 0);
  const lifetimeSavings = yearlySavings.reduce((a, b) => a + b, 0);

  let loanResult: FinanceResult["loan"] = null;
  if (input.loan) {
    const down = capex * (input.loan.downPaymentPercent / 100);
    const principal = capex - down;
    const monthly = loanPayment(principal, input.loan.interestRatePercent, input.loan.termYears);
    // Interés pagado por año (amortización francesa), para el escudo fiscal.
    const interestByYear: number[] = [];
    let balance = principal;
    const i = input.loan.interestRatePercent / 100 / 12;
    for (let y = 0; y < input.loan.termYears; y++) {
      let yearInterest = 0;
      for (let m = 0; m < 12; m++) {
        const interest = balance * i;
        yearInterest += interest;
        balance -= monthly - interest;
      }
      interestByYear.push(yearInterest);
    }
    const financed = buildFlows({ down, annualPayment: monthly * 12, term: input.loan.termYears, interestByYear });
    loanResult = {
      principalUsd: r2(principal),
      downPaymentUsd: r2(down),
      monthlyPaymentUsd: r2(monthly),
      totalInterestUsd: r2(monthly * 12 * input.loan.termYears - principal),
      npvUsd: r2(npv(discount, financed.flows)),
      irrPercent: roundOrNull(down > 0 ? irr(financed.flows) : null, 2),
      firstYearNetSavingsUsd: financed.rows[0]?.netCashFlowUsd ?? 0,
      cashFlows: financed.rows,
    };
  }

  const billBefore = firstYearMonths.reduce((s, m) => s + m.billBeforeUsd, 0);
  const billAfter = firstYearMonths.reduce((s, m) => s + m.billAfterUsd, 0);

  return {
    capexUsd: r2(capex),
    costPerWpUsd: r2(capex / Math.max(1, input.capacityKwp * 1000)),
    annualConsumptionKwh: r1(annualConsumption),
    annualProductionKwh: r1(annualProduction),
    billOffsetPercent: annualConsumption > 0 ? r1(Math.min(100, (annualProduction / annualConsumption) * 100)) : 0,
    firstYear: {
      billBeforeUsd: r2(billBefore),
      billAfterUsd: r2(billAfter),
      savingsUsd: r2(billBefore - billAfter),
      months: firstYearMonths,
    },
    cash: {
      npvUsd: r2(npv(discount, cash.flows)),
      irrPercent: roundOrNull(irr(cash.flows), 2),
      simplePaybackYears: roundOrNull(paybackYears(cash.flows), 1),
      discountedPaybackYears: roundOrNull(paybackYears(discountedFlows), 1),
      roiPercent: r1(((cash.flows.slice(1).reduce((a, b) => a + b, 0) - capex) / capex) * 100),
      lifetimeSavingsUsd: r2(lifetimeSavings),
      lcoeUsdPerKwh: discountedEnergy > 0 ? r4(discountedCosts / discountedEnergy) : 0,
      cashFlows: cash.rows,
    },
    loan: loanResult,
    environment: {
      co2AvoidedTonnesPerYear: r2((annualProduction * emission) / 1000),
      co2AvoidedTonnesLifetime: r2((yearlyProduction.reduce((a, b) => a + b, 0) * emission) / 1000),
      // ~22 kg CO2 absorbidos por árbol al año, durante la vida útil del sistema.
      treesEquivalent: Math.round((annualProduction * emission) / 22),
      emissionFactorKgPerKwh: emission,
    },
    assumptions: {
      tariffCategory: input.tariffCategory,
      tariffUsdPerKwh: input.tariffUsdPerKwh ?? TARIFFS_EC[input.tariffCategory].energyUsdPerKwh,
      tarifaDignidadApplied: input.tariffCategory === "residencial" && input.tariffUsdPerKwh === undefined,
      region: input.region ?? "sierra",
      netMetering: input.netMetering ?? "monthly_balance",
      creditResetMonths: input.creditResetMonths ?? 12,
      entityType: entity,
      incomeTaxPercent: entity === "empresa" ? taxRate * 100 : 0,
      acceleratedDepreciation: accelerated,
      depreciationYears: depYears,
      vatOnEquipmentPercent: TAX_EC.vatOnSolarEquipmentPercent,
      discountRatePercent: discount,
      analysisYears: years,
      degradationPercentPerYear: deg * 100,
      tariffEscalationPercentPerYear: escalation * 100,
      omCostPercentOfCapexPerYear: omPct * 100,
      inverterReplacementYear: invYear ?? null,
      totalOmAndReplacementUsd: r2(totalOm),
      note: "Valores referenciales. Reemplazar con la planilla real del cliente y el pliego tarifario vigente de ARCONEL.",
    },
  };
}

function r1(v: number) {
  return Math.round(v * 10) / 10;
}
function r2(v: number) {
  return Math.round(v * 100) / 100;
}
function r4(v: number) {
  return Math.round(v * 10000) / 10000;
}
function roundOrNull(v: number | null, digits: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
