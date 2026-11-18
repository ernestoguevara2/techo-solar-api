import { vi } from "vitest";

// after() y connection() solo funcionan dentro del ciclo de una solicitud de Next.
// En tests llamamos a los handlers directamente, así que los reemplazamos.
vi.mock("next/server", () => ({
  after: (task: () => void) => task(),
  connection: async () => undefined,
}));

process.env.LOG_REQUESTS = "false";
