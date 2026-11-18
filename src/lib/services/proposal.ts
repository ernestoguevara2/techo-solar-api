import type { BuildingInsights } from "./building-insights";
import type { ProposalInput } from "@/lib/schemas";

/**
 * Propuesta comercial en HTML lista para imprimir/guardar como PDF desde el
 * navegador. Todo texto que viene del cliente se escapa (evita XSS).
 */

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

// Una sola pasada con un regex a nivel de módulo (js-hoist-regexp). replace() reinicia lastIndex.
const HTML_SPECIAL_RE = /[&<>"']/g;
const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(HTML_SPECIAL_RE, (ch) => HTML_ENTITIES[ch]);
}

const usd = new Intl.NumberFormat("es-EC", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 0 });
const dec1 = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 1 });

function barChart(values: number[], color: string): string {
  const w = 560;
  const h = 180;
  const pad = 24;
  const max = Math.max(1, ...values);
  const bw = (w - pad * 2) / values.length;
  const bars = values
    .map((v, i) => {
      const bh = ((h - pad * 2) * v) / max;
      const x = pad + i * bw + bw * 0.15;
      const y = h - pad - bh;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${color}"/><text x="${(x + bw * 0.35).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="10" fill="#57534e">${MONTHS[i]}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Producción mensual estimada" style="width:100%;height:auto">${bars}</svg>`;
}

function cumulativeChart(values: number[], color: string): string {
  const w = 560;
  const h = 180;
  const pad = 28;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, values.length - 1);
  const y = (v: number) => h - pad - ((v - min) * (h - pad * 2)) / span;
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Flujo de caja acumulado" style="width:100%;height:auto">
<line x1="${pad}" x2="${w - pad}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#a8a29e" stroke-dasharray="4 4"/>
<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5"/>
<text x="${pad}" y="${h - 8}" font-size="10" fill="#57534e">Año 0</text>
<text x="${w - pad}" y="${h - 8}" font-size="10" fill="#57534e" text-anchor="end">Año ${values.length - 1}</text>
</svg>`;
}

export function renderProposalHtml(input: ProposalInput, insights: BuildingInsights, now = new Date()): string {
  const color = input.installer.primaryColor ?? "#b45309";
  const rec = insights.recommendation;
  const kwp = rec?.capacityKwp ?? insights.solarPotential.maxCapacityKwp;
  const panels = rec?.panelsCount ?? insights.solarPotential.maxArrayPanelsCount;
  const scale = insights.solarPotential.maxCapacityKwp > 0 ? kwp / insights.solarPotential.maxCapacityKwp : 0;
  const monthly = insights.solarPotential.monthlyEnergyAcKwh.map((v) => v * scale);
  const annual = monthly.reduce((a, b) => a + b, 0);
  const fin = rec?.financialAnalysis;
  const validUntil = new Date(now.getTime() + input.validityDays * 86_400_000);
  const dateFmt = new Intl.DateTimeFormat("es-EC", { dateStyle: "long" });
  const logo = input.installer.logoUrl
    ? `<img src="${escapeHtml(input.installer.logoUrl)}" alt="${escapeHtml(input.installer.name)}" style="max-height:56px;max-width:200px">`
    : `<strong style="font-size:22px">${escapeHtml(input.installer.name)}</strong>`;

  const financeBlock = fin
    ? `<section>
  <h2>Resultados financieros</h2>
  <div class="grid">
    <div class="kpi"><span>Inversión estimada</span><b>${usd.format(fin.capexUsd)}</b></div>
    <div class="kpi"><span>Ahorro año 1</span><b>${usd.format(fin.firstYear.savingsUsd)}</b></div>
    <div class="kpi"><span>Retorno de inversión</span><b>${fin.cash.simplePaybackYears !== null ? `${dec1.format(fin.cash.simplePaybackYears)} años` : "—"}</b></div>
    <div class="kpi"><span>TIR</span><b>${fin.cash.irrPercent !== null ? `${dec1.format(fin.cash.irrPercent)} %` : "—"}</b></div>
    <div class="kpi"><span>VAN (${fin.assumptions.discountRatePercent} %)</span><b>${usd.format(fin.cash.npvUsd)}</b></div>
    <div class="kpi"><span>Ahorro en ${fin.assumptions.analysisYears} años</span><b>${usd.format(fin.cash.lifetimeSavingsUsd)}</b></div>
  </div>
  <p class="muted">Planilla de energía actual ≈ ${usd.format(fin.firstYear.billBeforeUsd)}/año → con el sistema ≈ ${usd.format(fin.firstYear.billAfterUsd)}/año. Cobertura del consumo: ${dec1.format(fin.billOffsetPercent)} %.</p>
  <h3>Flujo de caja acumulado</h3>
  ${cumulativeChart([-fin.capexUsd, ...fin.cash.cashFlows.map((r) => r.cumulativeCashFlowUsd)], color)}
  ${
    fin.loan
      ? `<p><b>Con financiamiento:</b> entrada de ${usd.format(fin.loan.downPaymentUsd)} y cuota mensual de ${usd.format(fin.loan.monthlyPaymentUsd)}. Flujo neto del primer año: ${usd.format(fin.loan.firstYearNetSavingsUsd)}.</p>`
      : ""
  }
</section>`
    : `<section><p class="muted">Agrega el consumo o la planilla del cliente para calcular ahorro, retorno y TIR.</p></section>`;

  const env = fin?.environment;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Propuesta solar · ${escapeHtml(input.customer.name)}</title>
<style>
  :root { --brand: ${color}; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c1917; margin: 0; background: #fafaf9; }
  main { max-width: 820px; margin: 0 auto; background: #fff; padding: 40px 48px; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid var(--brand); padding-bottom: 16px; }
  h1 { font-size: 28px; margin: 24px 0 4px; }
  h2 { font-size: 18px; color: var(--brand); margin-top: 32px; border-bottom: 1px solid #e7e5e4; padding-bottom: 6px; }
  h3 { font-size: 14px; margin: 20px 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .kpi { border: 1px solid #e7e5e4; border-radius: 10px; padding: 12px; }
  .kpi span { display: block; font-size: 12px; color: #78716c; }
  .kpi b { font-size: 20px; font-variant-numeric: tabular-nums; }
  .muted { color: #78716c; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 6px 0; border-bottom: 1px solid #f5f5f4; }
  td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 40px; font-size: 11px; color: #a8a29e; border-top: 1px solid #e7e5e4; padding-top: 12px; }
  @media (max-width: 640px) { main { padding: 24px 16px; } .grid { grid-template-columns: 1fr 1fr; } }
  @media print { body { background: #fff; } main { padding: 0; } section { break-inside: avoid; } }
</style>
</head>
<body>
<main>
<header>
  ${logo}
  <div class="muted" style="text-align:right">
    ${escapeHtml(input.installer.phone ?? "")}<br>${escapeHtml(input.installer.email ?? "")}<br>${escapeHtml(input.installer.website ?? "")}
  </div>
</header>
<h1>Propuesta de sistema solar fotovoltaico</h1>
<p class="muted">Preparada para <b>${escapeHtml(input.customer.name)}</b>${input.customer.address ? ` · ${escapeHtml(input.customer.address)}` : ""}<br>
Fecha: ${dateFmt.format(now)} · Válida hasta: ${dateFmt.format(validUntil)}</p>

<section>
  <h2>Sistema propuesto</h2>
  <div class="grid">
    <div class="kpi"><span>Potencia</span><b>${dec1.format(kwp)} kWp</b></div>
    <div class="kpi"><span>Paneles</span><b>${num.format(panels)} × ${insights.panel.capacityWatts} W</b></div>
    <div class="kpi"><span>Producción anual</span><b>${num.format(annual)} kWh</b></div>
  </div>
  <table style="margin-top:16px">
    <tr><td>Área de techo analizada</td><td>${num.format(insights.roof.footprintAreaM2)} m²</td></tr>
    <tr><td>Tipo de techo / montaje</td><td>${insights.roof.type === "flat" ? "Plano (losa)" : "Inclinado"} · ${insights.layout.mounting === "tilted_rack" ? `estructura a ${insights.layout.tiltDegrees}°` : "coplanar"}</td></tr>
    <tr><td>Orientación de los paneles</td><td>${num.format(insights.layout.azimuthDegrees)}° (0° = norte)</td></tr>
    <tr><td>Rendimiento específico</td><td>${num.format(insights.solarPotential.specificYieldKwhPerKwp)} kWh/kWp/año</td></tr>
    <tr><td>Horas solares pico (en el plano)</td><td>${dec1.format(insights.solarPotential.peakSunHoursPerDay)} h/día</td></tr>
    <tr><td>Capacidad máxima del techo</td><td>${dec1.format(insights.solarPotential.maxCapacityKwp)} kWp (${num.format(insights.solarPotential.maxArrayPanelsCount)} paneles)</td></tr>
  </table>
  <h3>Producción mensual estimada (kWh)</h3>
  ${barChart(monthly, color)}
</section>

${financeBlock}

${
  env
    ? `<section><h2>Impacto ambiental</h2><p>Evita ≈ <b>${dec1.format(env.co2AvoidedTonnesPerYear)} t de CO₂ al año</b> (${dec1.format(env.co2AvoidedTonnesLifetime)} t en la vida útil), equivalente a ≈ ${num.format(env.treesEquivalent)} árboles.</p></section>`
    : ""
}

${input.notes ? `<section><h2>Notas</h2><p>${escapeHtml(input.notes).replace(/\n/g, "<br>")}</p></section>` : ""}

<footer>
  Estimación preliminar basada en imágenes/mapas y datos satelitales de irradiancia (${escapeHtml(insights.source.irradiance)}).
  Los valores finales dependen de la visita técnica, el estado estructural del techo, sombras locales y la planilla real.
  Tarifas y beneficios tributarios referenciales (ARCONEL / LOCE); confirmar antes de firmar.
  ${insights.source.footprint === "openstreetmap" ? "Huella del edificio © colaboradores de OpenStreetMap." : ""}
</footer>
</main>
</body>
</html>`;
}
