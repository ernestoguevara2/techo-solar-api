"use client";

import "leaflet/dist/leaflet.css";
import { memo, useEffect, useMemo } from "react";
import {
  CircleMarker,
  LayersControl,
  MapContainer,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { LatLngBoundsExpression, LatLngExpression } from "leaflet";
import type { Position } from "@/lib/geo/geometry";

/**
 * Mapa satelital (Leaflet). Este módulo pesa ~150 KB, así que la página lo carga
 * con next/dynamic y ssr:false (regla bundle-dynamic-imports del skill de Vercel).
 *
 * Las capas pesadas (paneles, huella, leads) son componentes memoizados
 * (rerender-memo): solo se recalculan cuando cambian sus datos, no cuando el
 * componente padre se vuelve a renderizar.
 */

export interface MapBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface MapLead {
  id: string;
  lat: number;
  lng: number;
  tier: "A" | "B" | "C";
  label: string;
}

interface Props {
  center: [number, number];
  footprint: Position[][] | null;
  panels: Position[][][];
  leads: MapLead[];
  focus: { lat: number; lng: number; zoom: number } | null;
  /** Vértices del techo que el usuario está dibujando ([lat, lng]). */
  draft: [number, number][] | null;
  onPick: (lat: number, lng: number) => void;
  onBoundsChange: (bbox: MapBbox) => void;
}

// Constantes fuera del componente para no recrearlas en cada render (rendering-hoist-jsx).
const FOOTPRINT_STYLE = { color: "#f59e0b", weight: 2, fillOpacity: 0.12 };
const PANEL_STYLE = { color: "#1e3a8a", weight: 0.5, fillColor: "#3b82f6", fillOpacity: 0.85 };
const LEAD_STYLE = {
  A: { color: "#fff", weight: 2, fillColor: "#16a34a", fillOpacity: 0.95 },
  B: { color: "#fff", weight: 2, fillColor: "#d97706", fillOpacity: 0.95 },
  C: { color: "#fff", weight: 2, fillColor: "#78716c", fillOpacity: 0.95 },
} as const;
const ESRI_ATTRIBUTION = "Imágenes © Esri, Maxar, Earthstar Geographics";
const OSM_ATTRIBUTION = "© colaboradores de OpenStreetMap";

/** Convierte posiciones GeoJSON [lng, lat] a [lat, lng] de Leaflet. */
function toLatLngs(ring: Position[]): LatLngExpression[] {
  return ring.map(([lng, lat]) => [lat, lng] as [number, number]);
}

function boundsOf(map: ReturnType<typeof useMap>): MapBbox {
  const b = map.getBounds();
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
}

function MapEvents({ onPick, onBoundsChange }: Pick<Props, "onPick" | "onBoundsChange">) {
  const map = useMapEvents({
    click: (e) => onPick(e.latlng.lat, e.latlng.lng),
    moveend: () => onBoundsChange(boundsOf(map)),
  });
  useEffect(() => {
    onBoundsChange(boundsOf(map));
  }, [map, onBoundsChange]);
  return null;
}

function FlyTo({ focus }: { focus: Props["focus"] }) {
  const map = useMap();
  useEffect(() => {
    if (focus) map.flyTo([focus.lat, focus.lng], focus.zoom, { duration: 0.8 });
  }, [map, focus]);
  return null;
}

const FootprintLayer = memo(function FootprintLayer({ footprint }: { footprint: Position[][] }) {
  const map = useMap();
  const rings = useMemo(() => footprint.map(toLatLngs), [footprint]);
  useEffect(() => {
    map.fitBounds(rings[0] as LatLngBoundsExpression, { padding: [60, 60], maxZoom: 20 });
  }, [map, rings]);
  return <Polygon positions={rings} pathOptions={FOOTPRINT_STYLE} />;
});

const PanelsLayer = memo(function PanelsLayer({ panels }: { panels: Position[][][] }) {
  const rings = useMemo(() => panels.map((p) => toLatLngs(p[0])), [panels]);
  return (
    <>
      {rings.map((ring, i) => (
        <Polygon key={i} positions={ring} pathOptions={PANEL_STYLE} interactive={false} />
      ))}
    </>
  );
});

const DRAFT_LINE = { color: "#facc15", weight: 2.5, dashArray: "6 4" };
const DRAFT_FILL = { color: "#facc15", weight: 2.5, dashArray: "6 4", fillOpacity: 0.15 };
const DRAFT_VERTEX = { color: "#0c0a09", weight: 2, fillColor: "#facc15", fillOpacity: 1 };

/** Contorno en edición: línea punteada, vértices y relleno cuando ya hay 3 puntos. */
const DraftLayer = memo(function DraftLayer({ draft }: { draft: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    el.style.cursor = "crosshair";
    map.doubleClickZoom.disable();
    return () => {
      el.style.cursor = "";
      map.doubleClickZoom.enable();
    };
  }, [map]);
  return (
    <>
      {draft.length >= 3 ? (
        <Polygon positions={draft} pathOptions={DRAFT_FILL} interactive={false} />
      ) : (
        <Polyline positions={draft} pathOptions={DRAFT_LINE} interactive={false} />
      )}
      {draft.map((p, i) => (
        <CircleMarker key={i} center={p} radius={5} pathOptions={DRAFT_VERTEX} interactive={false} />
      ))}
    </>
  );
});

const LeadsLayer = memo(function LeadsLayer({ leads, onPick }: { leads: MapLead[]; onPick: Props["onPick"] }) {
  return (
    <>
      {leads.map((l) => (
        <CircleMarker
          key={l.id}
          center={[l.lat, l.lng]}
          radius={l.tier === "A" ? 9 : 7}
          pathOptions={LEAD_STYLE[l.tier]}
          eventHandlers={{ click: () => onPick(l.lat, l.lng) }}
        >
          <Tooltip>{l.label}</Tooltip>
        </CircleMarker>
      ))}
    </>
  );
});

export default function SolarMap({ center, footprint, panels, leads, focus, draft, onPick, onBoundsChange }: Props) {
  return (
    // preferCanvas: miles de paneles se dibujan en un solo canvas en vez de miles de nodos SVG.
    <MapContainer center={center} zoom={17} maxZoom={21} className="h-full w-full" scrollWheelZoom preferCanvas>
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Satélite">
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution={ESRI_ATTRIBUTION}
            maxNativeZoom={19}
            maxZoom={21}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Mapa">
          <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={OSM_ATTRIBUTION} maxNativeZoom={19} maxZoom={21} />
        </LayersControl.BaseLayer>
      </LayersControl>
      <MapEvents onPick={onPick} onBoundsChange={onBoundsChange} />
      <FlyTo focus={focus} />
      {footprint ? <FootprintLayer footprint={footprint} /> : null}
      <PanelsLayer panels={panels} />
      <LeadsLayer leads={leads} onPick={onPick} />
      {draft ? <DraftLayer draft={draft} /> : null}
    </MapContainer>
  );
}
