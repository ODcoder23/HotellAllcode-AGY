/**
 * Testlar uchun .env ni yuklaydi.
 *
 * `npm run dev` da bu `--env-file` orqali bo'ladi, lekin vitest
 * o'z jarayonini ishga tushiradi va flagni ko'rmaydi. setupFiles
 * modul importlaridan OLDIN ishlaydi — shuning uchun config.ts
 * o'zgaruvchilarni topadi.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");

if (!existsSync(envPath)) {
  throw new Error(`.env topilmadi: ${envPath}`);
}

const raw = readFileSync(envPath, "utf8");
let loaded = 0;

for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  const key = m[1];
  const value = m[2].trim().replace(/^["']|["']$/g, "");
  if (process.env[key] === undefined) {
    process.env[key] = value;
    loaded++;
  }
}

if (loaded === 0) {
  throw new Error(".env o'qildi, lekin hech qanday o'zgaruvchi topilmadi");
}

/**
 * Test muhitini tozalash — har test fayli uchun.
 *
 * Ikki sabab:
 *   1. Mock kredit oynasi 5 daqiqa davom etadi — oldingi ishga
 *      tushishdan qolgan sarf keyingisini 429 bilan yiqitadi.
 *   2. Oldingi test bronlari DB'da qolsa, yangi bron 409 oladi
 *      (xona band).
 */
import { execSync } from "node:child_process";

// Mock kreditini tiklash
try {
  await fetch("http://localhost:4000/control/reset", { method: "POST" });
} catch {
  // Mock ishlamasa — beds24 testlari o'zi aytadi
}

// DB'ni toza seed holatiga qaytarish
try {
  execSync("npx tsx prisma/seed.ts", { stdio: "pipe" });
} catch (e) {
  console.warn("[test] seed ishlamadi:", String(e).slice(0, 120));
}

/**
 * Navbatni tozalash — REDIS ORQALI, BullMQ API'siz.
 *
 * `queue.obliterate()` ishlatib bo'lmaydi: u test jarayonida yangi
 * ulanish ochadi va serverdagi worker'larni buzadi. To'g'ridan-to'g'ri
 * kalitlarni o'chirish xavfsiz — worker'lar bunga chidaydi.
 *
 * Nima uchun kerak: oldingi test faylidan qolgan job keyingisining
 * DB holatiga tegib, o'tkinchi xatolarga olib keladi.
 */
try {
  const { execSync: exec } = await import("node:child_process");
  const cli = "/c/Users/Abdur/scoop/apps/redis/current/redis-cli.exe";
  exec(`"${cli}" --scan --pattern "bull:beds24-*" | xargs -r "${cli}" del`, {
    stdio: "pipe",
    shell: "bash",
  });
} catch {
  // Redis yo'q yoki kalit yo'q — muammo emas
}

/**
 * Worker'lar tinchishini kutish.
 *
 * Testlar bitta server bilan ishlaydi va uning webhook worker'i
 * doimiy ishlab turadi. Seed DB'ni tozalaganda worker hali eski
 * event'ni ishlab turgan bo'lishi mumkin — natijada keyingi test
 * kutilmagan holatni ko'radi. Qisqa pauza buni yo'qotadi.
 */
await new Promise((r) => setTimeout(r, 600));
