import { describe, expect, it } from "vitest";
import { analyzeFinance, irr, loanPayment, npv, paybackYears } from "@/lib/finance/analysis";
import { monthlyEnergyBill } from "@/lib/finance/tariffs-ec";

describe("matemática financiera", () => {
  it("VAN y TIR de flujos conocidos", () => {
    const flows = [-1000, 300, 300, 300, 300, 300];
    expect(npv(10, flows)).toBeCloseTo(137.24, 1);
    expect(irr(flows)!).toBeCloseTo(15.24, 1);
  });

  it("payback con interpolación", () => {
    expect(paybackYears([-1000, 400, 400, 400])).toBeCloseTo(2.5, 5);
    expect(paybackYears([-1000, 100, 100])).toBeNull();
  });

  it("cuota de crédito (amortización francesa)", () => {
    expect(loanPayment(10_000, 12, 5)).toBeCloseTo(222.44, 1);
    expect(loanPayment(12_000, 0, 1)).toBe(1000);
  });
});

describe("tarifas Ecuador", () => {
  it("aplica Tarifa Dignidad a hogares de bajo consumo", () => {
    expect(monthlyEnergyBill(100, "residencial", { region: "sierra" })).toBeCloseTo(4, 5);
    expect(monthlyEnergyBill(125, "residencial", { region: "costa" })).toBeCloseTo(5, 5);
    expect(monthlyEnergyBill(125, "residencial", { region: "sierra" })).toBeCloseTo(12.5, 5);
  });
});

describe("análisis financiero", () => {
  const production = new Array(12).fill(3_500); // 30 kWp × ~1.400 kWh/kWp/año
  const base = {
    capacityKwp: 30,
    monthlyProductionKwh: production,
    monthlyConsumptionKwh: 4_000,
    tariffCategory: "comercial" as const,
  };

  it("una empresa recupera la inversión en un plazo razonable", () => {
    const r = analyzeFinance(base);
    expect(r.capexUsd).toBeCloseTo(36_000, 0);
    expect(r.firstYear.savingsUsd).toBeCloseTo(3_500 * 12 * 0.092, 0);
    expect(r.cash.simplePaybackYears).not.toBeNull();
    expect(r.cash.simplePaybackYears!).toBeGreaterThan(4);
    expect(r.cash.simplePaybackYears!).toBeLessThan(15);
    expect(r.cash.cashFlows).toHaveLength(25);
    expect(r.environment.co2AvoidedTonnesPerYear).toBeGreaterThan(0);
  });

  it("la doble depreciación mejora el VAN de una empresa", () => {
    const withDep = analyzeFinance({ ...base, acceleratedDepreciation: true });
    const without = analyzeFinance({ ...base, acceleratedDepreciation: false });
    expect(withDep.cash.npvUsd).toBeGreaterThan(without.cash.npvUsd);
  });

  it("el balance neto acredita excedentes para meses siguientes", () => {
    const r = analyzeFinance({
      ...base,
      monthlyProductionKwh: [6000, 6000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      monthlyConsumptionKwh: 4000,
    });
    expect(r.firstYear.months[0].exportedKwh).toBe(2000);
    expect(r.firstYear.months[2].creditUsedKwh).toBe(4000);
  });

  it("en modo autoconsumo los excedentes no se pagan", () => {
    const net = analyzeFinance({ ...base, monthlyProductionKwh: new Array(12).fill(6000) });
    const self = analyzeFinance({ ...base, monthlyProductionKwh: new Array(12).fill(6000), netMetering: "self_consumption", selfConsumptionRatio: 0.5 });
    expect(self.firstYear.savingsUsd).toBeLessThan(net.firstYear.savingsUsd);
  });

  it("un hogar con Tarifa Dignidad ahorra muy poco (retorno largo)", () => {
    const r = analyzeFinance({
      capacityKwp: 1,
      monthlyProductionKwh: new Array(12).fill(110),
      monthlyConsumptionKwh: 105,
      tariffCategory: "residencial",
      region: "sierra",
    });
    expect(r.firstYear.savingsUsd).toBeLessThan(60);
    expect(r.cash.simplePaybackYears === null || r.cash.simplePaybackYears > 20).toBe(true);
  });

  it("calcula el escenario con crédito", () => {
    const r = analyzeFinance({ ...base, loan: { downPaymentPercent: 20, interestRatePercent: 11, termYears: 5 } });
    expect(r.loan).not.toBeNull();
    expect(r.loan!.downPaymentUsd).toBeCloseTo(7_200, 0);
    expect(r.loan!.monthlyPaymentUsd).toBeGreaterThan(0);
  });
});
