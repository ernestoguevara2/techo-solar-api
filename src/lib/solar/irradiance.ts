/**
 * Modelo de irradiancia mensual sobre el plano del panel (POA).
 *
 * Método clásico de Duffie & Beckman (Solar Engineering of Thermal Processes):
 *  1. Irradiación extraterrestre diaria H0 para el "día representativo" de cada mes (Klein).
 *  2. Índice de claridad Kt = GHI / H0 y fracción difusa mensual (Erbs).
 *  3. Distribución horaria de global y difusa (Collares-Pereira & Rabl, Liu & Jordan).
 *  4. Transposición al plano inclinado con cielo isotrópico + albedo, y pérdida
 *     por ángulo de incidencia (modelo ASHRAE).
 *
 * Es el mismo tipo de modelo que usan herramientas como PVWatts en su versión
 * simplificada; con inclinaciones bajas (lo normal en Ecuador) el error frente a
 * modelos horarios con TMY es pequeño.
 */

const DEG = Math.PI / 180;
const SOLAR_CONSTANT_KW = 1.367;

export const KLEIN_DAYS = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344] as const;
export const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function declinationRad(dayOfYear: number): number {
  return 23.45 * DEG * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
}

export function sunsetHourAngleRad(latRad: number, decl: number): number {
  const x = -Math.tan(latRad) * Math.tan(decl);
  return Math.acos(Math.max(-1, Math.min(1, x)));
}

/** Irradiación extraterrestre diaria sobre superficie horizontal (kWh/m²/día). */
export function extraterrestrialDaily(latDeg: number, dayOfYear: number): number {
  const phi = latDeg * DEG;
  const decl = declinationRad(dayOfYear);
  const ws = sunsetHourAngleRad(phi, decl);
  return (
    (24 / Math.PI) *
    SOLAR_CONSTANT_KW *
    (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365)) *
    (Math.cos(phi) * Math.cos(decl) * Math.sin(ws) + ws * Math.sin(phi) * Math.sin(decl))
  );
}

/** Fracción difusa mensual (Erbs et al., 1982). */
export function diffuseFractionMonthly(kt: number, sunsetHourAngleDeg: number): number {
  const k = Math.max(0.3, Math.min(0.8, kt));
  const fd =
    sunsetHourAngleDeg <= 81.4
      ? 1.391 - 3.56 * k + 4.189 * k ** 2 - 2.137 * k ** 3
      : 1.311 - 3.022 * k + 3.427 * k ** 2 - 1.821 * k ** 3;
  return Math.max(0.1, Math.min(1, fd));
}

export interface PlaneSpec {
  tiltDegrees: number;
  /** Azimut de brújula hacia donde mira el panel (0 = norte, 90 = este, 180 = sur). */
  azimuthDegrees: number;
  albedo?: number;
}

export interface DayProfileStep {
  /** Irradiancia efectiva en el plano (W/m²), después de pérdidas por ángulo de incidencia. */
  irradianceWm2: number;
  /** Duración del paso en horas. */
  hours: number;
}

export interface MonthlyPoa {
  /** POA diaria promedio (kWh/m²/día), sin pérdida por ángulo de incidencia. */
  poaDaily: number[];
  /** POA efectiva diaria promedio (kWh/m²/día), con pérdida por ángulo de incidencia. */
  poaEffectiveDaily: number[];
  /** Perfil intradiario del día representativo de cada mes (para el modelo térmico). */
  profiles: DayProfileStep[][];
}

const STEP_DEG = 2.5; // 10 minutos

export function monthlyPlaneOfArray(latDeg: number, monthlyGhiDaily: readonly number[], plane: PlaneSpec): MonthlyPoa {
  const phi = latDeg * DEG;
  const beta = plane.tiltDegrees * DEG;
  // Duffie-Beckman: azimut de superficie medido desde el sur, este negativo, oeste positivo.
  const gamma = (plane.azimuthDegrees - 180) * DEG;
  const rho = plane.albedo ?? 0.2;
  const b0 = 0.05; // coeficiente ASHRAE del modificador por ángulo de incidencia

  const poaDaily: number[] = [];
  const poaEffectiveDaily: number[] = [];
  const profiles: DayProfileStep[][] = [];

  for (let m = 0; m < 12; m++) {
    const n = KLEIN_DAYS[m];
    const decl = declinationRad(n);
    const ws = sunsetHourAngleRad(phi, decl);
    const wsDeg = ws / DEG;
    const H = Math.max(0, monthlyGhiDaily[m]);
    const H0 = extraterrestrialDaily(latDeg, n);
    const kt = H0 > 0 ? H / H0 : 0;
    const Hd = H * diffuseFractionMonthly(kt, wsDeg);

    const a = 0.409 + 0.5016 * Math.sin(ws - 60 * DEG);
    const b = 0.6609 - 0.4767 * Math.sin(ws - 60 * DEG);
    const denom = Math.sin(ws) - ws * Math.cos(ws);

    // Pesos sin normalizar de global (rt) y difusa (rd) a lo largo del día.
    const steps: { w: number; rt: number; rd: number }[] = [];
    let sumRt = 0;
    let sumRd = 0;
    for (let wDeg = -wsDeg + STEP_DEG / 2; wDeg < wsDeg; wDeg += STEP_DEG) {
      const w = wDeg * DEG;
      const base = Math.max(0, (Math.cos(w) - Math.cos(ws)) / denom);
      const rt = (a + b * Math.cos(w)) * base;
      const rd = base;
      steps.push({ w, rt, rd });
      sumRt += rt;
      sumRd += rd;
    }

    let poa = 0;
    let poaEff = 0;
    const profile: DayProfileStep[] = [];
    const stepHours = STEP_DEG / 15;
    for (const s of steps) {
      const I = sumRt > 0 ? (H * s.rt) / sumRt : 0;
      const Id = sumRd > 0 ? Math.min(I, (Hd * s.rd) / sumRd) : 0;
      const Ib = Math.max(0, I - Id);

      const cosZ = Math.cos(phi) * Math.cos(decl) * Math.cos(s.w) + Math.sin(phi) * Math.sin(decl);
      const cosT =
        Math.sin(decl) * Math.sin(phi) * Math.cos(beta) -
        Math.sin(decl) * Math.cos(phi) * Math.sin(beta) * Math.cos(gamma) +
        Math.cos(decl) * Math.cos(phi) * Math.cos(beta) * Math.cos(s.w) +
        Math.cos(decl) * Math.sin(phi) * Math.sin(beta) * Math.cos(gamma) * Math.cos(s.w) +
        Math.cos(decl) * Math.sin(beta) * Math.sin(gamma) * Math.sin(s.w);

      const rb = cosZ > 0.017 ? Math.max(0, cosT) / cosZ : 0;
      const beam = Ib * Math.min(rb, 10);
      const diffuse = Id * (1 + Math.cos(beta)) / 2;
      const ground = I * rho * (1 - Math.cos(beta)) / 2;
      const iamBeam = cosT > 0 ? Math.max(0, 1 - b0 * (1 / cosT - 1)) : 0;
      const iamDiffuse = 0.95; // valor típico integrado para difusa/albedo

      poa += beam + diffuse + ground;
      const eff = beam * iamBeam + (diffuse + ground) * iamDiffuse;
      poaEff += eff;
      profile.push({ irradianceWm2: (eff / stepHours) * 1000, hours: stepHours });
    }

    poaDaily.push(poa);
    poaEffectiveDaily.push(poaEff);
    profiles.push(profile);
  }

  return { poaDaily, poaEffectiveDaily, profiles };
}

/**
 * GHI diaria de cielo despejado (modelo de Haurwitz) para el día representativo de cada mes.
 * Se usa solo como respaldo cuando ningún proveedor de datos responde.
 */
export function clearSkyMonthlyGhi(latDeg: number): number[] {
  const phi = latDeg * DEG;
  return KLEIN_DAYS.map((n) => {
    const decl = declinationRad(n);
    const ws = sunsetHourAngleRad(phi, decl);
    let wh = 0;
    for (let w = -ws; w < ws; w += STEP_DEG * DEG) {
      const cosZ = Math.cos(phi) * Math.cos(decl) * Math.cos(w) + Math.sin(phi) * Math.sin(decl);
      if (cosZ > 0) wh += 1098 * cosZ * Math.exp(-0.057 / cosZ) * (STEP_DEG / 15);
    }
    return wh / 1000;
  });
}
