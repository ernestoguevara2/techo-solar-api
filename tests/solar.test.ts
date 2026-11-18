import { describe, expect, it } from "vitest";
import { clearSkyMonthlyGhi, extraterrestrialDaily, monthlyPlaneOfArray } from "@/lib/solar/irradiance";
import { estimateProduction, totalLossPercent } from "@/lib/solar/production";

// GHI mensual típica de Quito (kWh/m²/día), del orden de los datos satelitales publicados.
const QUITO_GHI = [4.6, 4.5, 4.4, 4.3, 4.4, 4.6, 5.0, 5.2, 5.0, 4.8, 4.7, 4.6];
const QUITO_T = [14, 14, 14, 14, 14, 14, 14, 14.5, 14.5, 14, 14, 14];

describe("geometría solar", () => {
  it("la irradiación extraterrestre en el ecuador ronda 9–10,5 kWh/m²/día todo el año", () => {
    for (const n of [17, 105, 198, 288]) {
      const h0 = extraterrestrialDaily(0, n);
      expect(h0).toBeGreaterThan(9);
      expect(h0).toBeLessThan(10.6);
    }
  });

  it("con inclinación 0 la POA es igual a la GHI", () => {
    const poa = monthlyPlaneOfArray(-0.18, QUITO_GHI, { tiltDegrees: 0, azimuthDegrees: 0 });
    poa.poaDaily.forEach((v, m) => expect(v).toBeCloseTo(QUITO_GHI[m], 2));
  });

  it("cerca del ecuador, 10° de inclinación cambia la producción anual menos de 3 %", () => {
    const flat = monthlyPlaneOfArray(-0.18, QUITO_GHI, { tiltDegrees: 0, azimuthDegrees: 0 });
    const tilted = monthlyPlaneOfArray(-0.18, QUITO_GHI, { tiltDegrees: 10, azimuthDegrees: 0 });
    const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
    expect(Math.abs(sum(tilted.poaDaily) / sum(flat.poaDaily) - 1)).toBeLessThan(0.03);
  });

  it("el cielo despejado en el ecuador da 6–8 kWh/m²/día", () => {
    for (const v of clearSkyMonthlyGhi(0)) {
      expect(v).toBeGreaterThan(6);
      expect(v).toBeLessThan(8);
    }
  });
});

describe("producción", () => {
  it("las pérdidas por defecto suman ≈ 14,08 % como PVWatts", () => {
    expect(totalLossPercent()).toBeCloseTo(14.08, 1);
  });

  it("1 kWp en Quito produce entre 1.200 y 1.500 kWh/año", () => {
    const r = estimateProduction({
      latitude: -0.18,
      monthlyGhiDaily: QUITO_GHI,
      monthlyTempC: QUITO_T,
      capacityKwp: 1,
      planes: [{ tiltDegrees: 10, azimuthDegrees: 0 }],
    });
    expect(r.specificYieldKwhPerKwp).toBeGreaterThan(1200);
    expect(r.specificYieldKwhPerKwp).toBeLessThan(1500);
    expect(r.performanceRatio).toBeGreaterThan(0.7);
    expect(r.performanceRatio).toBeLessThan(0.85);
    expect(r.monthlyAcKwh).toHaveLength(12);
    expect(r.lifetime).toHaveLength(25);
    expect(r.lifetime[24].acKwh).toBeLessThan(r.lifetime[0].acKwh);
  });

  it("el calor reduce la producción (Guayaquil vs Quito con la misma irradiancia)", () => {
    const base = { latitude: -2.2, monthlyGhiDaily: QUITO_GHI, capacityKwp: 10, planes: [{ tiltDegrees: 10, azimuthDegrees: 0 }] };
    const cool = estimateProduction({ ...base, monthlyTempC: QUITO_T });
    const hot = estimateProduction({ ...base, monthlyTempC: new Array(12).fill(27) });
    expect(hot.annualAcKwh).toBeLessThan(cool.annualAcKwh);
    expect(hot.temperatureLossPercent).toBeGreaterThan(cool.temperatureLossPercent);
  });

  it("escala linealmente con la capacidad", () => {
    const args = { latitude: -0.18, monthlyGhiDaily: QUITO_GHI, monthlyTempC: QUITO_T, planes: [{ tiltDegrees: 10, azimuthDegrees: 0 }] };
    const one = estimateProduction({ ...args, capacityKwp: 1 });
    const fifty = estimateProduction({ ...args, capacityKwp: 50 });
    expect(fifty.annualAcKwh / one.annualAcKwh).toBeCloseTo(50, 0);
  });
});
