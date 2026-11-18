import { apiRoute, corsPreflight } from "@/lib/api/handler";
import { ApiError } from "@/lib/api/problem";
import { projectPolygon } from "@/lib/geo/geometry";
import { layoutPanels } from "@/lib/geo/layout";
import { layoutRequestSchema } from "@/lib/schemas";
import { resolvePanel } from "@/lib/solar/panels";

const MAX_ROOF_AREA_M2 = Number(process.env.MAX_ROOF_AREA_M2 ?? 200_000);
const MAX_PANELS = Number(process.env.MAX_PANELS ?? 20_000);

/** POST /api/v1/panel-layout — distribuye paneles sobre el polígono del techo. */
export const POST = apiRoute({ cost: 2, maxBodyBytes: 2 * 1024 * 1024 }, async (ctx) => {
  const body = await ctx.body(layoutRequestSchema);
  const projected = projectPolygon(body.roof);
  if (projected.areaM2 > MAX_ROOF_AREA_M2) {
    throw new ApiError("area-too-large", `El techo supera ${MAX_ROOF_AREA_M2} m².`);
  }
  const panel = resolvePanel(body.panel);
  const lo = body.layout ?? {};
  const mounting = lo.mounting ?? "tilted_rack";
  const tilt = lo.tiltDegrees ?? (mounting === "tilted_rack" ? 10 : 0);

  const layout = layoutPanels(body.roof, {
    panel: { widthM: panel.widthM, heightM: panel.heightM, capacityWatts: panel.capacityWatts },
    orientation: lo.orientation ?? "auto",
    mounting,
    tiltDegrees: tilt,
    setbackM: lo.setbackM ?? (projected.areaM2 >= 1_000 ? 1 : 0.5),
    colGapM: lo.colGapM ?? 0.02,
    rowGapM: lo.rowGapM,
    azimuthDegrees: lo.azimuthDegrees,
    latitude: projected.center.lat,
    obstructions: lo.obstructions,
    obstructionBufferM: lo.obstructionBufferM ?? 0.5,
    designSunElevationDegrees: lo.designSunElevationDegrees ?? 25,
    maxPanels: MAX_PANELS,
    includeGeometry: body.includeGeometry,
  });

  return { panel, mounting, ...layout };
});

export const OPTIONS = corsPreflight;
