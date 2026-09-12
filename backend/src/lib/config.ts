/**
 * Muhit o'zgaruvchilari — bitta joyda o'qiladi va tekshiriladi.
 * Yo'q bo'lsa server ko'tarilmaydi (jimgina noto'g'ri ishlashdan ko'ra
 * darhol to'xtash yaxshi).
 */

const req = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Muhit o'zgaruvchisi yo'q: ${key}`);
  return v;
};

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v ? Number(v) : fallback;
};

export const config = {
  databaseUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  port: num("PORT", 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  isDev: (process.env.NODE_ENV ?? "development") === "development",

  // TZ 18-band
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",

  // TZ 13-band — frontendga chiqmaydi
  beds24: {
    baseUrl: process.env.BEDS24_BASE_URL ?? "http://localhost:4000",
    creditLimit: num("BEDS24_CREDIT_LIMIT", 100),
    creditSafetyThreshold: num("BEDS24_CREDIT_SAFETY_THRESHOLD", 10),
  },

  // 04-fayl §9
  webhook: {
    authMode: (process.env.WEBHOOK_AUTH_MODE ?? "ip_token") as "signature" | "ip_token",
    urlToken: process.env.WEBHOOK_URL_TOKEN ?? "",
    signatureSecret: process.env.WEBHOOK_SIGNATURE_SECRET ?? "",
    allowedIps: (process.env.WEBHOOK_ALLOWED_IPS ?? "").split(",").filter(Boolean),
  },

  // TZ 7-band
  sourceOfTruth: {
    rates: (process.env.SOURCE_OF_TRUTH_RATES ?? "pms") as "pms" | "beds24",
    availability: (process.env.SOURCE_OF_TRUTH_AVAILABILITY ?? "pms") as "pms" | "beds24",
  },

  pendingPaymentTimeoutHours: num("PENDING_PAYMENT_TIMEOUT_HOURS", 24),
  pollIntervalMinutes: num("POLL_INTERVAL_MINUTES", 15),
} as const;
