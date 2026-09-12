/**
 * Imron Hotel PMS — backend server
 *
 * FAZA 2A: ichki REST API (Shaxmatka uchun)
 *
 * Ishga tushirish:  npm run dev
 */

import express from "express";
import { fileURLToPath } from "node:url";
import { config } from "./lib/config.js";
import { prisma } from "./lib/prisma.js";
import { errorHandler } from "./lib/errors.js";
import { roomsRouter } from "./routes/rooms.js";
import { reservationsRouter } from "./routes/reservations.js";
import { ratesRouter } from "./routes/rates.js";
import { adminRouter } from "./routes/admin.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { isRedisHealthy, getQueueCounts, shutdownQueues } from "./queues/index.js";
import { startRealtimeServer, stopRealtimeServer, getRealtimeStats } from "./realtime/server.js";
import "./queues/workers.js";     // worker'lar ishga tushadi

const app = express();

// raw body saqlanadi — webhook signature (HMAC) tekshiruvi uchun
// (04-fayl §9). JSON.stringify(req.body) ishlatib bo'lmaydi:
// kalitlar tartibi va bo'sh joylar o'zgarib, hash mos kelmaydi.
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
  },
}));

// CORS — dev uchun ochiq; production'da Nginx orqali (TZ 18-band)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// So'rovlarni log qilish (dev)
if (config.isDev) {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// --- Health (FAZA 0 mezoni) ---------------------------------
app.get("/health", async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    isRedisHealthy(),
  ]);

  // TZ 17, 19-band: Redis yo'q bo'lsa ham PMS ishlashda davom etadi.
  // Webhook'lar DB'da QUEUED holatida to'planadi, Redis qaytganda
  // yuboriladi. Shuning uchun "degraded", "down" emas.
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? (redisOk ? "ok" : "degraded") : "down",
    database: dbOk ? "connected" : "disconnected",
    redis: redisOk ? "connected" : "disconnected",
    realtime: getRealtimeStats(),
    phase: "8",
    timestamp: new Date().toISOString(),
  });
});

/** Navbat holati (05-fayl §8) */
app.get("/api/admin/queues", async (_req, res) => {
  try {
    res.json({ redis: await isRedisHealthy(), queues: await getQueueCounts() });
  } catch (e) {
    res.status(503).json({ redis: false, error: String(e).slice(0, 200) });
  }
});

// --- API ----------------------------------------------------
app.use("/api/rooms", roomsRouter);
app.use("/api/reservations", reservationsRouter);
app.use("/api/rate-plans", ratesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/webhooks", webhooksRouter);

// --- Admin sahifalari (backend ichida) ----------------------
// ISH CHEGARASI: mavjud Admin Panel kodiga kirish yo'q, shuning
// uchun mapping/ulanish/log sahifalari shu yerda. Oddiy HTML+fetch,
// framework yo'q. Keyinroq mavjud panelga ko'chirish mumkin.
// fileURLToPath — Windows'da URL.pathname oldiga "/" qo'shadi
// va yo'l "/C:/..." bo'lib ishlamaydi.
app.use("/admin", express.static(fileURLToPath(new URL("../public/admin", import.meta.url))));

// --- 404 ----------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `Endpoint topilmadi: ${req.method} ${req.path}` });
});

// --- Xato handler (oxirgi) ----------------------------------
app.use(errorHandler);

// --- Ishga tushirish ----------------------------------------
const server = app.listen(config.port, () => {
  console.log(`\n  Imron PMS backend — FAZA 8`);
  console.log(`  http://localhost:${config.port}`);
  console.log(`  DB: ${config.databaseUrl.replace(/:[^:@]*@/, ":***@")}`);
});

// WebSocket shu HTTP server ustiga o'rnatiladi — alohida port kerak
// emas, Nginx ham bitta proxy qoidasi bilan o'tkazadi (09-fayl §4).
startRealtimeServer(server);
console.log("");

// Toza to'xtash
const shutdown = async (sig: string) => {
  console.log(`\n${sig} — to'xtatilmoqda...`);
  await stopRealtimeServer().catch(() => {});
  server.close();
  await shutdownQueues().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { app };
