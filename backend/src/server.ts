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

const app = express();

app.use(express.json({ limit: "1mb" }));

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
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "ok",
      database: "connected",
      phase: "5",
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ status: "degraded", database: "disconnected" });
  }
});

// --- API ----------------------------------------------------
app.use("/api/rooms", roomsRouter);
app.use("/api/reservations", reservationsRouter);
app.use("/api/rate-plans", ratesRouter);
app.use("/api/admin", adminRouter);

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
  console.log(`\n  Imron PMS backend — FAZA 2A`);
  console.log(`  http://localhost:${config.port}`);
  console.log(`  DB: ${config.databaseUrl.replace(/:[^:@]*@/, ":***@")}\n`);
});

// Toza to'xtash
const shutdown = async (sig: string) => {
  console.log(`\n${sig} — to'xtatilmoqda...`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { app };
