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
  /**
   * Server qaysi interfeysda tinglaydi.
   *
   * Serverda "127.0.0.1" qo'yiladi: port internetdan ochiq
   * bo'lmasin, faqat SSH tunnel orqali kirilsin. Kompyuterda
   * bo'sh qoldiriladi — hamma interfeys (mobil qurilmadan
   * tekshirish uchun qulay).
   */
  host: process.env.HOST ?? undefined,
  nodeEnv: process.env.NODE_ENV ?? "development",
  isDev: (process.env.NODE_ENV ?? "development") === "development",

  // TZ 18-band
  jwtSecret: process.env.JWT_SECRET ?? "",

  /**
   * JWT majburiymi (TZ 18-band).
   *
   * STANDART — YOQILGAN (2026-09-26). Faqat aniq `AUTH_REQUIRED="false"`
   * o'chiradi (lokal sinov). Ilgari standart "false" edi: `.env` dan
   * qator tushib qolsa yoki noto'g'ri yozilsa ("True", "1") butun API
   * — bronlar, mehmon telefonlari, moliya — login'siz ochilib qolardi.
   */
  authRequired: (process.env.AUTH_REQUIRED ?? "true").trim().toLowerCase() !== "false",

  /**
   * Rate limiting o'chirilganmi.
   *
   * Testlar o'nlab so'rov yuboradi va cheklovga urilib qolishi
   * mumkin — bu tekshirilayotgan xatti-harakat emas. Cheklovning
   * o'zi alohida test bilan sinaladi.
   */
  rateLimitDisabled: process.env.RATE_LIMIT_DISABLED === "true",

  /**
   * CORS uchun ruxsat etilgan domenlar (vergul bilan).
   *
   * Bo'sh bo'lsa: faqat bir xil origin ishlaydi (frontend
   * backendning o'zidan xizmat qilinadi, shuning uchun bu
   * odatdagi holat). Tashqi domen kerak bo'lsa shu yerga
   * yoziladi:
   *   CORS_ORIGINS="https://imron-hotel.uz,https://admin.imron-hotel.uz"
   *
   * Avval `*` edi — har qanday sayt brauzer orqali API'ga
   * so'rov yubora olardi.
   */
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Telegram bot (founder uchun).
   *
   * `token` bo'sh bo'lsa bot umuman ishga tushmaydi — backend
   * normal ishlayveradi. Bu ataylab: token yo'qligi xato emas,
   * shunchaki bot o'chirilgan degani.
   *
   * `founderIds` — botga kira oladigan Telegram chat ID'lari.
   * Ro'yxatda bo'lmagan har kimga "kirish yo'q" javobi beriladi
   * va hech qanday ma'lumot ko'rsatilmaydi.
   */
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    founderIds: (process.env.TELEGRAM_FOUNDER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /** Yangi bron kelganda avtomatik xabar yuborilsinmi */
    notifyBookings: process.env.TELEGRAM_NOTIFY_BOOKINGS !== "false",

    /**
     * 2-bot: tozalik (BOTLAR-REJA.md, 2026-09-17).
     *
     * Alohida bot va alohida guruh — farosh mehmonxona
     * moliyasini ko'rmasligi kerak. Boshqaruv boti bilan
     * birlashtirilsa bitta token ikkala auditoriyaga ochiq
     * bo'lardi.
     *
     * `cleaningGroupId` manfiy bo'ladi (guruh ID'lari
     * "-100..." ko'rinishida).
     *
     * Ikkalasi ham bo'sh bo'lsa bot ishga tushmaydi va
     * backend normal ishlayveradi.
     */
    cleaningToken: process.env.TELEGRAM_CLEANING_BOT_TOKEN ?? "",
    cleaningGroupId: process.env.TELEGRAM_CLEANING_GROUP_ID ?? "",

    /**
     * 3-bot: oshxona (BOTLAR-REJA.md).
     *
     * Oshpazlar nonushta porsiyalarini bilishi uchun.
     */
    kitchenToken: process.env.TELEGRAM_KITCHEN_BOT_TOKEN ?? "",
    kitchenChatIds: (process.env.TELEGRAM_KITCHEN_CHAT_ID ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",

  pendingPaymentTimeoutHours: num("PENDING_PAYMENT_TIMEOUT_HOURS", 24),
} as const;

/**
 * Ishlab chiqarishda xavfsiz bo'lmagan sozlamalarni to'sadi.
 *
 * NEGA KERAK: `AUTH_REQUIRED=false` barcha ruxsat tekshiruvlarini
 * o'tkazib yuboradi, qisqa `JWT_SECRET` esa soxta token yasashga
 * imkon beradi. Bu qiymatlar bilan ishlab chiqarishga chiqish
 * mehmonlar ma'lumoti va pul hisobini ochiq qoldiradi.
 *
 * Server ISHGA TUSHMAYDI — jimgina ogohlantirish yetarli emas,
 * chunki uni hech kim o'qimaydi.
 */
export function assertProductionSafe(): void {
  // Har muhitda: auth yoqilgan, lekin imzo kaliti yo'q — login 500 berardi
  if (config.authRequired && !config.jwtSecret) {
    throw new Error("JWT_SECRET yo'q — AUTH_REQUIRED yoqilganda token imzolab bo'lmaydi");
  }

  if (config.nodeEnv !== "production") return;

  const problems: string[] = [];

  if (!config.authRequired) {
    problems.push(
      'AUTH_REQUIRED="false" — barcha ruxsat tekshiruvlari o\'chirilgan'
    );
  }

  if ((process.env.RATE_LIMIT_DISABLED ?? "false") === "true") {
    problems.push('RATE_LIMIT_DISABLED="true" — so\'rov cheklovi yo\'q');
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    problems.push("JWT_SECRET yo'q yoki juda qisqa (32+ belgi kerak)");
  }

  if (problems.length === 0) return;

  throw new Error(
    "Ishlab chiqarish sozlamalari xavfsiz emas:\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nTuzatish: .env ni to'g'rilang yoki NODE_ENV ni o'zgartiring.\n" +
      "Token yaratish:\n" +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}
