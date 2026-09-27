/**
 * Beds24 qoldiqlarini tozalash (2026-09-26, egasi qarori: Beds24
 * integratsiyasi olib tashlanadi, API orqali kelgan test tarixi
 * tizimda qolmasin).
 *
 *   npm run beds24:purge                     # faqat hisobot, hech narsa o'zgarmaydi
 *   npm run beds24:purge -- --confirm=<baza> # o'chiradi
 *
 * QACHON: yangi kod yuborilgach, lekin `prisma migrate deploy` DAN OLDIN
 * (SERVER.md, "Beds24'ni olib tashlash"). Migratsiya `origin`, `channelId`
 * ustunlarini va kanal jadvallarini o'chiradi — undan keyin Beds24'dan
 * kelgan bronni PMS bronidan ajratib bo'lmaydi. Skript xom SQL bilan
 * ishlaydi va ustun bormi-yo'qligini o'zi tekshiradi: migratsiyadan keyin
 * ishga tushsa, faqat qolgan narsalarni (yopiq kunlar, jurnal, Redis)
 * tozalaydi.
 *
 * NIMA O'CHIRILADI
 *   - Beds24'dan kelgan bronlar (`origin = CHANNEL`) — to'lov, xizmat va
 *     avtomatik komissiya yozuvlari bilan; shu bronlar uchun yaratilgan va
 *     boshqa broni qolmagan mehmonlar
 *   - Beds24 yopgan kunlar (`RoomDayStatus`, sababi "Beds24:")
 *   - kanal jadvallari: SyncLog, WebhookEvent, SyncState, ChannelBlock,
 *     ChannelMapping, ChannelConnection (shifrlangan token), Channel
 *   - audit jurnalidagi Beds24 amallari (mapping.*, webhook.*, channel.*, fx.*)
 *   - availability keshi (sayt uni bronlardan qayta hisoblaydi)
 *   - Redis: beds24-* navbatlari va eski davriy vazifalar
 *
 * NIMA QOLADI
 *   PMS'da (sayt, qabulxona) yaratilgan bronlar — Beds24'ga yuborilgan
 *   bo'lsa ham; narxlar, xodimlar, sozlamalar, xonalar, foydalanuvchilar.
 *   SOURCE_OF_TRUTH_* va FX_RATE_* sozlamalarini migratsiya o'chiradi:
 *   qolgan dollar bronni so'mga o'girish uchun kurs unga kerak.
 *   Barcha test bronlarini o'chirish kerak bo'lsa — alohida
 *   `npm run data:reset` (egasining qarori).
 *
 * XAVFSIZLIK
 *   - Baza nomi aniq yozilmasa hech narsa o'chirilmaydi.
 *   - Bazadagi o'zgarishlar bitta tranzaksiyada.
 *   - OLDIN TO'LIQ ZAXIRA (pg_dump, SERVER.md) — skript uni tekshira olmaydi.
 */

import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const prisma = new PrismaClient();

/** Olib tashlangan navbatlar va davriy vazifalar */
const OLD_QUEUES = [
  "beds24-webhook", "beds24-reservation-sync", "beds24-availability-sync",
  "beds24-rate-sync", "beds24-retry",
];
const OLD_SCHEDULERS = [
  "cron_poll_beds24", "cron_pull_rates", "cron_drift_check", "cron_catch_up", "cron_fx_refresh",
];
const CHANNEL_TABLES = [
  "SyncLog", "WebhookEvent", "SyncState", "ChannelBlock", "ChannelMapping", "ChannelConnection", "Channel",
];
const AUDIT_WHERE = `action LIKE 'mapping.%' OR action LIKE 'webhook.%' OR action LIKE 'channel.%' OR action LIKE 'fx.%'`;

type Row = Record<string, unknown>;

function dbTarget(): { host: string; name: string } {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return { host: `${u.hostname}:${u.port || "5432"}`, name: u.pathname.replace(/^\//, "") };
  } catch {
    return { host: "?", name: "?" };
  }
}

async function tableExists(name: string): Promise<boolean> {
  const r = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`, name
  );
  return r.length > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, table, column
  );
  return r.length > 0;
}

async function count(sql: string, ...args: unknown[]): Promise<number> {
  const r = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(sql, ...args);
  return Number(r[0]?.n ?? 0);
}

/** Toshkent bo'yicha bugungi sana (xona holatini qayta hisoblash uchun) */
function hotelToday(): string {
  return new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
}

async function main() {
  const { host, name } = dbTarget();
  const confirm = process.argv.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);
  const apply = !!confirm && confirm === name;

  console.log(`\n  Beds24 qoldiqlarini tozalash`);
  console.log(`  Baza: ${name} @ ${host}\n`);

  const hasOrigin = await columnExists("Reservation", "origin");
  const tables = (await Promise.all(CHANNEL_TABLES.map(async (t) => ((await tableExists(t)) ? t : null))))
    .filter((t): t is string => t !== null);

  // --- 1. Hisobot -------------------------------------------------
  const channelRes = hasOrigin
    ? await prisma.$queryRawUnsafe<Row[]>(
        `SELECT r.id, r."roomId", r."checkIn"::text AS "checkIn", r."checkOut"::text AS "checkOut",
                r.source::text AS source, r.status::text AS status, g."fullName" AS guest
         FROM "Reservation" r JOIN "Guest" g ON g.id = r."guestId"
         WHERE r.origin = 'CHANNEL'
         ORDER BY r."checkIn"`
      )
    : [];
  const resIds = channelRes.map((r) => String(r.id));

  const payments = resIds.length
    ? await count(`SELECT count(*) AS n FROM "Payment" WHERE "reservationId" = ANY($1::text[])`, resIds) : 0;
  const charges = resIds.length
    ? await count(`SELECT count(*) AS n FROM "Charge" WHERE "reservationId" = ANY($1::text[])`, resIds) : 0;
  const blockedDays = await count(`SELECT count(*) AS n FROM "RoomDayStatus" WHERE "blockReason" LIKE 'Beds24:%'`);
  const audits = await count(`SELECT count(*) AS n FROM "AuditLog" WHERE ${AUDIT_WHERE}`);
  const tableCounts: Array<[string, number]> = [];
  for (const t of tables) tableCounts.push([t, await count(`SELECT count(*) AS n FROM "${t}"`)]);

  if (!hasOrigin) {
    console.log(`  Migratsiya allaqachon qo'llangan — Beds24 bronlarini ajratib bo'lmaydi, faqat qolganlari.\n`);
  }
  console.log(`  Beds24'dan kelgan bronlar: ${channelRes.length} (to'lov ${payments}, xizmat ${charges})`);
  for (const r of channelRes.slice(0, 50)) {
    console.log(`    ${r.roomId}  ${r.checkIn}..${r.checkOut}  ${String(r.source).padEnd(11)} ${String(r.status).padEnd(15)} ${r.guest}`);
  }
  if (channelRes.length > 50) console.log(`    ... yana ${channelRes.length - 50} ta`);
  console.log(`  Beds24 yopgan kunlar: ${blockedDays}`);
  console.log(`  Kanal jadvallari: ${tableCounts.map(([t, n]) => `${t} ${n}`).join(", ") || "yo'q"}`);
  console.log(`  Audit jurnali (Beds24 amallari): ${audits}`);
  console.log(`  Redis: ${OLD_QUEUES.length} navbat, ${OLD_SCHEDULERS.length} davriy vazifa\n`);

  if (!apply) {
    console.log(`  HECH NARSA O'ZGARTIRILMADI.`);
    console.log(`  Davom etish uchun (oldin pg_dump zaxira!):`);
    console.log(`    npm run beds24:purge -- --confirm=${name}\n`);
    process.exitCode = confirm ? 1 : 0;
    return;
  }

  // --- 2. Baza — bitta tranzaksiya --------------------------------
  const done = await prisma.$transaction(async (tx) => {
    const out: Record<string, number> = {};

    if (resIds.length > 0) {
      const guestIds = (await tx.$queryRawUnsafe<Row[]>(
        `SELECT DISTINCT "guestId" FROM "Reservation" WHERE id = ANY($1::text[])`, resIds
      )).map((g) => String(g.guestId));

      out.expenses = await tx.$executeRawUnsafe(
        `DELETE FROM "Expense" WHERE "reservationId" = ANY($1::text[])`, resIds
      );
      // To'lov va xizmatlar ON DELETE CASCADE bilan o'chadi
      out.reservations = await tx.$executeRawUnsafe(
        `DELETE FROM "Reservation" WHERE id = ANY($1::text[])`, resIds
      );
      out.guests = await tx.$executeRawUnsafe(
        `DELETE FROM "Guest" g WHERE g.id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM "Reservation" r WHERE r."guestId" = g.id)`, guestIds
      );
    }

    out.blockedDays = await tx.$executeRawUnsafe(
      `DELETE FROM "RoomDayStatus" WHERE "blockReason" LIKE 'Beds24:%'`
    );

    // Bog'liqlik tartibida: Channel oxirida
    for (const t of tables) out[t] = await tx.$executeRawUnsafe(`DELETE FROM "${t}"`);

    out.audits = await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE ${AUDIT_WHERE}`);

    // Kesh — sayt qidiruvi bronlardan qayta hisoblaydi (publicBooking.ts)
    out.availability = await tx.$executeRawUnsafe(`DELETE FROM "Availability"`);

    // Xona holati: o'chirilgan bron xonani "band" qilib qoldirmasin.
    // Ta'mirdagi va iflos xonalarga tegilmaydi (iflosni tozalash tasdiqlaydi)
    const today = hotelToday();
    out.rooms = await tx.$executeRawUnsafe(
      `WITH target AS (
         SELECT rm.id, (CASE
           WHEN EXISTS (SELECT 1 FROM "Reservation" r WHERE r."roomId" = rm.id AND r.status = 'CHECKED_IN'
                        AND r."checkIn" <= $1::date AND r."checkOut" > $1::date) THEN 'OCCUPIED'
           WHEN EXISTS (SELECT 1 FROM "Reservation" r WHERE r."roomId" = rm.id
                        AND r.status IN ('CONFIRMED', 'PENDING_PAYMENT')
                        AND r."checkIn" <= $1::date AND r."checkOut" > $1::date) THEN 'RESERVED'
           ELSE 'AVAILABLE' END)::"RoomStatus" AS status
         FROM "Room" rm
         WHERE rm.status IN ('OCCUPIED', 'RESERVED', 'AVAILABLE')
       )
       UPDATE "Room" rm SET status = t.status
       FROM target t
       WHERE rm.id = t.id AND rm.status <> t.status`,
      today
    );

    await tx.$executeRawUnsafe(
      `INSERT INTO "AuditLog" (id, action, "entityType", after, "createdAt")
       VALUES (gen_random_uuid()::text, 'settings.changed', 'Beds24Purge', $1::jsonb, NOW())`,
      JSON.stringify({ reason: "Beds24 integratsiyasi olib tashlandi", ...out })
    );
    return out;
  }, { timeout: 120_000 });

  console.log(`  Baza:`);
  for (const [k, v] of Object.entries(done)) console.log(`    ${k}: ${v}`);

  // --- 3. Redis ---------------------------------------------------
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log(`\n  REDIS_URL yo'q — navbatlar tozalanmadi.\n`);
    return;
  }
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  try {
    for (const q of OLD_QUEUES) {
      const queue = new Queue(q, { connection: connection as never });
      await queue.obliterate({ force: true }).catch((e) => console.warn(`    ${q}: ${String(e).slice(0, 100)}`));
      await queue.close();
    }
    const maintenance = new Queue("pms-maintenance", { connection: connection as never });
    for (const id of OLD_SCHEDULERS) await maintenance.removeJobScheduler(id).catch(() => false);
    await maintenance.close();
    console.log(`\n  Redis: navbatlar va eski davriy vazifalar o'chirildi.\n`);
  } finally {
    await connection.quit();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
