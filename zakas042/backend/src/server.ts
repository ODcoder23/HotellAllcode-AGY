/**
 * Imron Hotel PMS — backend server
 *
 * REST API (sayt, Shaxmatka, admin panel), WebSocket, Beds24 (channel
 * manager) navbatlari, davriy vazifalar va Telegram botlar. Frontend
 * ham shu serverdan beriladi.
 *
 * Ishga tushirish:  npm run dev
 */

import express from "express";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { config, assertProductionSafe } from "./lib/config.js";
import { prisma } from "./lib/prisma.js";
import { errorHandler } from "./lib/errors.js";
import { roomsRouter } from "./routes/rooms.js";
import { reservationsRouter } from "./routes/reservations.js";
import { ratesRouter } from "./routes/rates.js";
import { adminRouter } from "./routes/admin.js";
import { isRedisHealthy, getQueueCounts, shutdownQueues } from "./queues/index.js";
import { startRealtimeServer, stopRealtimeServer, getRealtimeStats } from "./realtime/server.js";
import { authRouter } from "./routes/auth.js";
import { publicRouter } from "./routes/public.js";
import { channelRouter } from "./routes/channel.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { parseAuth, authRequired, requireAuth, requirePermission } from "./lib/authMiddleware.js";
import { internalLimiter } from "./lib/rateLimit.js";
import { scheduleMaintenance } from "./queues/scheduler.js";
// TZ 11-band: Beds24 navbatlari worker'lari va o'lik xat (beds24-retry)
import "./queues/workers.js";
import "./queues/deadLetter.js";
import { startBot, stopBot } from "./bot/index.js";
import { startCleaningBot, stopCleaningBot } from "./bot/cleaning-bot.js";
import { startKitchenBot, stopKitchenBot } from "./bot/kitchen-bot.js";

const app = express();

// 2 MB: xodim va xona turi rasmlari `data:` URL bo'lib keladi
app.use(express.json({ limit: "2mb" }));

// Brauzer xavfsizlik sarlavhalari — barcha javoblarga.
// `nosniff`: brauzer javob turini taxmin qilmasin (yuklangan fayl
// skript bo'lib ishlamasin). `SAMEORIGIN`: sahifalar begona saytda
// iframe ichida ochilmasin (clickjacking); admin panel Shaxmatkani
// o'z iframe'ida ochadi — u bir xil origin.
app.use((_req, res, next) => {
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "SAMEORIGIN");
  res.header("Referrer-Policy", "same-origin");
  next();
});

// CORS (TZ 18-band)
//
// Frontend backendning o'zidan xizmat qilinadi, shuning uchun
// odatda CORS umuman kerak emas — brauzer bir xil origin'ga
// so'rovni to'smaydi.
//
// `CORS_ORIGINS` faqat tashqi domen kerak bo'lganda to'ldiriladi
// (masalan sayt alohida domenda bo'lsa). Ro'yxatda bo'lmagan
// origin'ga ruxsat berilmaydi.
//
// Avval `*` edi: har qanday sayt brauzer orqali bronlarni
// o'qishi, yaratishi va bekor qilishi mumkin edi.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && config.corsOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    // Origin ro'yxatga qarab o'zgargani uchun kesh kalitiga
    // qo'shiladi — aks holda proxy bitta javobni hammaga beradi
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }

  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// Nginx orqasida haqiqiy IP — rate limit va AuditLog uchun
// (10-fayl §7: cheklov IP bo'yicha)
app.set("trust proxy", 1);

// Token bor bo'lsa o'qiladi. Majburiylikni har route o'zi
// `requireAuth` bilan belgilaydi (10-fayl §1, 3-talab).
app.use(parseAuth);

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

  // Redis yo'q bo'lsa ham PMS ishlashda davom etadi (bron, to'lov,
  // Shaxmatka) — faqat davriy vazifalar kechikadi. Shuning uchun
  // "degraded", "down" emas.
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? (redisOk ? "ok" : "degraded") : "down",
    database: dbOk ? "connected" : "disconnected",
    redis: redisOk ? "connected" : "disconnected",
    realtime: getRealtimeStats(),
    // TZ 18-band: production'da `auth` true bo'lishi SHART
    security: {
      auth: authRequired(),
      rateLimit: !config.rateLimitDisabled,
    },
    timestamp: new Date().toISOString(),
  });
});

/** Navbat holati (05-fayl §8). Faqat auth bilan */
app.get("/api/admin/queues", requireAuth, requirePermission("audit.read"), async (_req, res) => {
  try {
    res.json({ redis: await isRedisHealthy(), queues: await getQueueCounts() });
  } catch (e) {
    res.status(503).json({ redis: false, error: String(e).slice(0, 200) });
  }
});

// --- API ----------------------------------------------------
app.use("/api/auth", authRouter);

// Website uchun ommaviy API (TZ 3, 20-band).
// JWT TALAB QILINMAYDI — mijoz ro'yxatdan o'tmagan. Himoya: rate
// limiting, honeypot, qat'iy validatsiya (13-fayl §6).
app.use("/api/public", publicRouter);
app.use("/api/rooms", internalLimiter, roomsRouter);
app.use("/api/reservations", internalLimiter, reservationsRouter);
app.use("/api/rate-plans", internalLimiter, ratesRouter);
// channelRouter — Channel manager (Beds24): ulash, bog'lash, jurnal, kurs.
// Limiter bitta: ikki marta qo'yilsa so'rov ikki hisoblanadi
app.use("/api/admin", internalLimiter, channelRouter, adminRouter);
// Beds24 webhook (TZ 10-band) — JWT emas, URL'dagi maxfiy token
app.use("/api/webhooks", webhooksRouter);

// --- Yuklangan fayllar (tozalash rasmlari) ------------------
// fileURLToPath — Windows'da URL.pathname oldiga "/" qo'shadi
const uploadsDir = fileURLToPath(new URL("../public/uploads", import.meta.url));
app.use("/uploads", express.static(uploadsDir));

// --- Frontend (sayt, admin panel, Shaxmatka) ----------------
// Birlashtirishdan keyin uchala frontend shu serverdan xizmat
// qilinadi. Natijada port konflikti, CORS va API_BASE muammosi
// bir vaqtda hal bo'ladi — hammasi bitta origin.
//
// DIQQAT: bu qator 404 handler'dan OLDIN turishi shart.
const appDir = fileURLToPath(new URL("../public/app", import.meta.url));
app.use(express.static(appDir));

// Channel manager alohida sahifalari (/admin/connection.html va h.k.).
// Sahifaning o'zida ma'lumot yo'q — hammasi admin token'i bilan API'dan
const adminPagesDir = fileURLToPath(new URL("../public/admin", import.meta.url));
app.use("/admin", express.static(adminPagesDir));

// "/" → sayt (mehmonlar uchun)
app.get("/", (_req, res) => {
  res.sendFile(join(appDir, "index.html"));
});

// "/admin-panel" → xodimlar paneli
app.get(["/admin-panel", "/panel"], (_req, res) => {
  res.sendFile(join(appDir, "admin-panel.html"));
});

// "/shaxmatka" → bandlik jadvali
app.get("/shaxmatka", (_req, res) => {
  res.sendFile(join(appDir, "shaxmatka.html"));
});

// --- 404 ----------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `Endpoint topilmadi: ${req.method} ${req.path}`, code: "NOT_FOUND" });
});

// --- Xato handler (oxirgi) ----------------------------------
app.use(errorHandler);

// --- Ishga tushirish ----------------------------------------
//
// Ishlab chiqarishda xavfsiz bo'lmagan sozlama bilan ishga
// tushirmaymiz: `AUTH_REQUIRED=false` bilan chiqish mehmonlar
// ma'lumotini ochiq qoldirardi. Dev rejimida hech narsa tekshirilmaydi.
assertProductionSafe();

// `config.host` berilsa faqat o'sha interfeysda tinglaydi
// (serverda "127.0.0.1"), aks holda hammasida.
const server = (config.host
  ? app.listen(config.port, config.host, onReady)
  : app.listen(config.port, onReady));

function onReady() {
  console.log(`\n  Imron PMS backend`);
  console.log(`  http://localhost:${config.port}`);
  console.log(`  DB: ${config.databaseUrl.replace(/:[^:@]*@/, ":***@")}`);
}

// WebSocket shu HTTP server ustiga o'rnatiladi — alohida port kerak
// emas, Nginx ham bitta proxy qoidasi bilan o'tkazadi (09-fayl §4).
startRealtimeServer(server);

// Davriy vazifalar (queues/scheduler.ts): polling, catch-up, narx,
// drift, kurs va PMS vazifalari. Redis yo'q bo'lsa jim o'tkazib
// yuboriladi — PMS ishlayveradi (TZ 17, 19-band).
void scheduleMaintenance();

// Telegram botlar. Token yo'q bo'lsa jim o'tkazib yuboriladi —
// botlar ixtiyoriy qism.
//
//   1-bot: boshqaruv (egasi/menejer) — moliya, bronlar
//   2-bot: tozalik (farroshlar guruhi) — topshiriqlar
//   3-bot: oshxona (oshpazlar) — porsiyalar
//
// Uchalasi ALOHIDA: xavfsizlik va ruxsatlar bo'lingan.
void startBot();
void startCleaningBot();
void startKitchenBot();

console.log("");

// Toza to'xtash
const shutdown = async (sig: string) => {
  console.log(`\n${sig} — to'xtatilmoqda...`);
  await stopBot().catch(() => {});
  await stopCleaningBot().catch(() => {});
  await stopKitchenBot().catch(() => {});
  await stopRealtimeServer().catch(() => {});
  server.close();
  await shutdownQueues().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { app };
