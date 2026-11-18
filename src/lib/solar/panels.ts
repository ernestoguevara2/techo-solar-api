/**
 * Catálogo de paneles genéricos (sin marca). El cliente puede enviar su
 * propio panel en cada solicitud con `panel: { capacityWatts, widthM, heightM }`.
 */

export interface PanelSpec {
  id: string;
  description: string;
  capacityWatts: number;
  /** Lado corto (m). */
  widthM: number;
  /** Lado largo (m). */
  heightM: number;
  /** Coeficiente de temperatura de potencia (%/°C, negativo). */
  tempCoefficientPctPerC: number;
}

export const PANEL_CATALOG: readonly PanelSpec[] = [
  {
    id: "generico-580w",
    description: "Monocristalino TOPCon 144 medias celdas, uso comercial/industrial",
    capacityWatts: 580,
    widthM: 1.134,
    heightM: 2.278,
    tempCoefficientPctPerC: -0.3,
  },
  {
    id: "generico-440w",
    description: "Monocristalino 108 medias celdas, uso residencial",
    capacityWatts: 440,
    widthM: 1.134,
    heightM: 1.722,
    tempCoefficientPctPerC: -0.34,
  },
] as const;

export const DEFAULT_PANEL = PANEL_CATALOG[0];

export function resolvePanel(input?: Partial<PanelSpec> & { id?: string }): PanelSpec {
  if (!input) return DEFAULT_PANEL;
  const base = PANEL_CATALOG.find((p) => p.id === input.id) ?? DEFAULT_PANEL;
  return {
    ...base,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    id: input.id && PANEL_CATALOG.some((p) => p.id === input.id) ? input.id : input.capacityWatts ? "personalizado" : base.id,
  } as PanelSpec;
}
