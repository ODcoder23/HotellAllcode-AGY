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
 * kutilmagan holatni ko'radi.
 *
 * FAZA 13 dan keyin uzaytirildi: `public.test.ts` o'nlab bron
 * yaratadi, ularning har biri reservation-sync va availability-sync
 * job'i qo'yadi. Fayl tugaganda bu job'lar hali navbatda turadi va
 * keyingi faylning worker'ini band qiladi — natijada FAZA 10
 * testlari "Beds24'ga yetmadi" deb yiqiladi.
 *
 * Yuqoridagi kalit tozalash navbatni bo'shatadi, bu pauza esa
 * ishlab turgan job tugashini kutadi.
 */
await new Promise((r) => setTimeout(r, 1500));


/**
 * Testlar uchun avtomatik ADMIN token (TZ 18-band, FAZA 12).
 *
 * MUAMMO: `AUTH_REQUIRED=true` bo'lganda barcha `/api/*` so'rovlar
 * token talab qiladi. Mavjud test fayllari (FAZA 2A dan beri)
 * to'g'ridan-to'g'ri `fetch` chaqiradi va token yubormaydi —
 * hammasi 401 oladi.
 *
 * YECHIM: global `fetch` ni bir marta o'raymiz. Agar so'rov shu
 * serverga ketayotgan bo'lsa va `Authorization` sarlavhasi
 * qo'yilmagan bo'lsa, ADMIN token qo'shiladi.
 *
 * NEGA HAR TESTNI TAHRIRLAMAYMIZ: auth ilova darajasidagi kesib
 * o'tuvchi masala, uni har testga qo'lda ulash 200+ joyda
 * takrorlash demakdir va bittasi esdan chiqsa test sababsiz
 * yiqiladi. Auth mantig'ining o'zi `security.test.ts` da aniq
 * tekshiriladi — u yerda token ataylab yuborilmaydi.
 */
const PMS_ORIGIN = "http://localhost:3000";

const healthRes = await fetch(`${PMS_ORIGIN}/health`).catch(() => null);
const health = healthRes?.ok ? ((await healthRes.json()) as { security?: { auth?: boolean } }) : null;

if (health?.security?.auth === true) {
  const loginRes = await fetch(`${PMS_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@imron.local", password: "admin12345" }),
  }).catch(() => null);

  const token = loginRes?.ok
    ? ((await loginRes.json()) as { token?: string }).token
    : undefined;

  if (token) {
    const original = globalThis.fetch;

    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      // Faqat PMS'ga ketayotgan so'rovlar. Mock server (:4000) o'z
      // autentifikatsiyasini ishlatadi, unga tegmaymiz.
      if (url.startsWith(PMS_ORIGIN)) {
        const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
          return original(input, { ...init, headers });
        }
      }
      return original(input, init);
    }) as typeof fetch;

    console.log("[test] AUTH_REQUIRED=true — so'rovlarga ADMIN token qo'shiladi");
  } else {
    console.warn("[test] auth yoqilgan, lekin login bo'lmadi — testlar 401 olishi mumkin");
  }
}


/**
 * Mock Beds24 kreditini tiklaymiz.
 *
 * Mock 100 kredit / 5 daqiqa cheklovini haqiqiy Beds24 kabi
 * qo'llaydi (03-fayl §3). Testlar ketma-ket ishlaganda cheklov
 * tugab qoladi va sync job'lari KECHIKTIRILADI — bu to'g'ri
 * xatti-harakat, lekin keyingi test faylini yiqitadi.
 *
 * Cheklovning o'zi `beds24.test.ts` da ataylab sinaladi
 * (`/control/drain-credits`), shuning uchun uni bu yerda tiklash
 * qopqoqni yopmaydi.
 */
await fetch("http://localhost:4000/control/refill-credits", { method: "POST" }).catch(() => {});
