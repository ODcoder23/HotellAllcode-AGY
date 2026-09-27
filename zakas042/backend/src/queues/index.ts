/**
 * Redis va BullMQ — davriy vazifalar navbati uchun umumiy ulanish
 *
 * Yagona navbat: `pms-maintenance` (queues/scheduler.ts) — to'lanmagan
 * bronlar, STOP ufqi, tozalash, oshxona hisoboti, audit tozalash.
 * Beds24 navbatlari (beds24-*) 2026-09-26 da olib tashlangan.
 *
 * Redis o'chsa PMS ishlashda davom etadi: bron, to'lov, Shaxmatka
 * Redis'ga bog'liq emas. Faqat davriy vazifalar kechikadi va
 * `/health` "degraded" qaytaradi.
 */

import { type Queue, type Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "../lib/config.js";

// --- Redis ulanishi -----------------------------------------

/**
 * BullMQ `maxRetriesPerRequest: null` talab qiladi — aks holda
 * ulanish uzilganda job'lar yo'qoladi.
 */
export const redisConnection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
});

redisConnection.on("error", (e) => {
  // Ulanish yo'qolsa BullMQ o'zi qayta ulanadi — bu yerda faqat log
  if (config.isDev) console.warn(`[redis] ${e.message}`);
});

// --- Navbat nomlari -----------------------------------------

export const QUEUE = {
  /** Davriy vazifalar */
  maintenance: "pms-maintenance",
} as const;

// --- Ro'yxat (monitoring va toza to'xtash) -------------------

const queues: Queue[] = [];
const workers: Worker[] = [];

/** Navbatni monitoring ro'yxatiga qo'shadi (scheduler.ts) */
export function registerQueue(q: Queue): void {
  if (!queues.includes(q)) queues.push(q);
}

export function registerWorker(w: Worker): void {
  workers.push(w);
}

// --- Monitoring (05-fayl §8) --------------------------------

export async function getQueueCounts() {
  const out: Record<string, Record<string, number>> = {};
  for (const q of queues) {
    out[q.name] = await q.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  }
  return out;
}

/** Eski yiqilgan va tugagan job'larni tozalaydi */
export async function cleanQueueHistory(): Promise<Record<string, { failed: number; completed: number }>> {
  const result: Record<string, { failed: number; completed: number }> = {};
  for (const q of queues) {
    const failedCleaned = await q.clean(0, 10000, "failed");
    const completedCleaned = await q.clean(0, 10000, "completed");
    result[q.name] = {
      failed: failedCleaned.length,
      completed: completedCleaned.length,
    };
  }
  return result;
}

/**
 * Redis ishlayaptimi — /health uchun.
 *
 * MUHIM: `redisConnection` da `maxRetriesPerRequest: null` — bu
 * BullMQ uchun shart, lekin `ping()` cheksiz kutadi degani. Redis
 * o'chganda `/health` umuman javob bermay qolardi. Shuning uchun
 * ping 1 soniyalik TIMEOUT bilan o'raladi.
 */
export async function isRedisHealthy(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("redis ping timeout")), 1000);
    });
    await Promise.race([redisConnection.ping(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Toza to'xtatish ----------------------------------------

export async function shutdownQueues(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(queues.map((q) => q.close()));
  await redisConnection.quit();
}
