import { apiRoute } from "@/lib/api/handler";
import { authConfigured } from "@/lib/api/auth";
import { googleSolarEnabled } from "@/lib/providers/google-solar";

export const GET = apiRoute({ auth: false }, async () => {
  return {
    status: "ok",
    service: "techo-solar-api",
    version: "1.0.0",
    time: new Date().toISOString(),
    config: {
      authEnabled: authConfigured(),
      googleSolarEnabled: googleSolarEnabled(),
      irradianceProviders: (process.env.IRRADIANCE_PROVIDERS ?? "pvgis-nsrdb,nasa-power,pvgis-era5,clear-sky").split(","),
    },
  };
});
