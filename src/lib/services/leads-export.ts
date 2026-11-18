import type { Lead } from "./prospecting";

/**
 * Exportación de leads a CSV (para importar en un CRM o Excel).
 * Módulo puro, sin dependencias de servidor: lo usan la API y la interfaz demo.
 */

const CSV_COLUMNS: string[] = [
  "id",
  "name",
  "buildingType",
  "segment",
  "address",
  "lat",
  "lng",
  "footprintAreaM2",
  "estimatedKwp",
  "estimatedPanels",
  "estimatedAnnualKwh",
  "estimatedAnnualSavingsUsd",
  "leadScore",
  "tier",
  "phone",
  "website",
  "openStreetMap",
  "googleMaps",
];

// Regex a nivel de módulo (js-hoist-regexp).
const FORMULA_START_RE = /^[=+\-@\t\r]/;
const NEEDS_QUOTES_RE = /[",\n;]/;
const QUOTE_RE = /"/g;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  // Los números (p. ej. longitudes negativas de Ecuador) van tal cual.
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  // Evita inyección de fórmulas al abrir el CSV en Excel/Sheets (solo en texto).
  if (FORMULA_START_RE.test(s)) s = `'${s}`;
  return NEEDS_QUOTES_RE.test(s) ? `"${s.replace(QUOTE_RE, '""')}"` : s;
}

export function leadsToCsv(leads: Lead[]): string {
  const rows = leads.map((l) =>
    [
      l.id,
      l.name,
      l.buildingType,
      l.segment,
      l.address,
      l.center.lat,
      l.center.lng,
      l.footprintAreaM2,
      l.estimatedKwp,
      l.estimatedPanels,
      l.estimatedAnnualKwh,
      l.estimatedAnnualSavingsUsd,
      l.leadScore,
      l.tier,
      l.contact.phone,
      l.contact.website,
      l.links.openStreetMap,
      l.links.googleMaps,
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}
