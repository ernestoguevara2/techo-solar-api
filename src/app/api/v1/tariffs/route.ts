import { apiRoute, corsPreflight } from "@/lib/api/handler";
import {
  FINANCE_DEFAULTS,
  GRID_EMISSION_FACTOR_KG_PER_KWH,
  TARIFA_DIGNIDAD,
  TARIFFS_EC,
  TAX_EC,
} from "@/lib/finance/tariffs-ec";

/** GET /api/v1/tariffs — supuestos tarifarios, tributarios y financieros que usa la API para Ecuador. */
export const GET = apiRoute({ cost: 0 }, async () => ({
  country: "EC",
  currency: "USD",
  tariffs: TARIFFS_EC,
  tarifaDignidad: TARIFA_DIGNIDAD,
  tax: TAX_EC,
  gridEmissionFactorKgPerKwh: GRID_EMISSION_FACTOR_KG_PER_KWH,
  financeDefaults: FINANCE_DEFAULTS,
  disclaimer: "Valores referenciales; cada endpoint permite sobrescribirlos por solicitud.",
}));

export const OPTIONS = corsPreflight;
