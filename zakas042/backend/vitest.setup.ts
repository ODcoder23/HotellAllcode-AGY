/**
 * Testlar uchun muhit.
 *
 * `npm run dev` da env `--env-file` orqali keladi, lekin vitest o'z
 * jarayonini ishga tushiradi va flagni ko'rmaydi. setupFiles modul
 * importlaridan OLDIN ishlaydi — shuning uchun config.ts
 * o'zgaruvchilarni topadi.
 *
 * Tartib: jarayon muhiti (masalan `set -a; . test.env`) ustun, `.env`
 * faqat yetishmaganini to'ldiradi.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const envPath = resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL yo'q — test.env ni yuklang (zakas042/README.md, \"Testlar\")");
}

/**
 * Server manzili — BIR JOYDA.
 *
 * `127.0.0.1`, `localhost` EMAS: Node 18+ da `localhost` avval IPv6
 * (`::1`) ga hal bo'ladi va test fayllari tushunarsiz "fetch failed"
 * bilan yiqiladi.
 */
const ipv4 = (url: string) => url.replace("//localhost:", "//127.0.0.1:");

const PMS_ORIGIN = ipv4(
  process.env.PMS_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`
);

// Test fayllari ham shu manzilni ko'rsin
process.env.PMS_URL ??= PMS_ORIGIN;

/**
 * JONLI BAZANI TOZALASHDAN HIMOYA.
 *
 * Har test fayli oldidan seed ishlaydi va bazadagi BARCHA bron, narx,
 * foydalanuvchini o'chiradi. Lokal `.env` SSH tunnel orqali serverdagi
 * JONLI bazaga (`localhost:5433/imron_pms`) ulanadi. Ilgari himoya
 * faqat host nomini ("localhost") tekshirardi — tunnel orqali jonli
 * baza ham "localhost" bo'lib ko'rinardi va test uni o'chirib yuborardi.
 *
 * Endi baza NOMIDA "test" bo'lishi shart (`imron_test`). Boshqa nom —
 * testlar umuman boshlanmaydi. Ataylab bo'lsa: ALLOW_TEST_DB_WIPE=true.
 */
const dbUrl = process.env.DATABASE_URL ?? "";
let dbName = "";
try { dbName = new URL(dbUrl).pathname.replace(/^\//, ""); } catch { /* pastda xato */ }

if (!/test/i.test(dbName) && process.env.ALLOW_TEST_DB_WIPE !== "true") {
  throw new Error(
    `Testlar bazani TOZALAYDI, lekin baza nomida "test" yo'q: "${dbName}"\n` +
    `  ${dbUrl.replace(/:[^:@]*@/, ":***@")}\n\n` +
    `Bu ishlab chiqarish bazasi bo'lishi mumkin — barcha bronlar yo'qoladi.\n` +
    `Alohida test bazasi: zakas042/README.md, "Testlar" bo'limi.`
  );
}

/**
 * DB'ni toza seed holatiga qaytarish — har test fayli uchun: oldingi
 * test bronlari DB'da qolsa, yangi bron 409 oladi (xona band).
 */
try {
  execSync("npx tsx prisma/seed.ts", { stdio: "pipe", env: { ...process.env, SEED_ALLOW_WIPE: "true" } });
} catch (e) {
  console.warn("[test] seed ishlamadi:", String(e).slice(0, 300));
}

/**
 * Testlar uchun avtomatik ADMIN token (TZ 18-band).
 *
 * MUAMMO: `AUTH_REQUIRED=true` bo'lganda barcha `/api/*` so'rovlar
 * token talab qiladi. Test fayllari to'g'ridan-to'g'ri `fetch`
 * chaqiradi va token yubormaydi — hammasi 401 oladi.
 *
 * YECHIM: global `fetch` ni bir marta o'raymiz. So'rov shu serverga
 * ketayotgan bo'lsa va `Authorization` qo'yilmagan bo'lsa, ADMIN token
 * qo'shiladi. Auth mantig'ining o'zi `security.test.ts` da aniq
 * tekshiriladi — u yerda token ataylab yuboriladi yoki yuborilmaydi.
 */
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
