/**
 * Test tarixini tozalash — ishga tushirishdan oldin (2026-09-25).
 *
 * Egasi: bazadagi bronlar TEST ma'lumoti. Faqat TEST BRONLARI va
 * ularga bog'liq yozuvlar o'chiriladi — narxlar, maoshlar va
 * sozlamalar QOLADI.
 *
 *   npm run data:reset -- --confirm=<baza_nomi>
 *
 * XAVFSIZLIK
 *   - Baza nomi aniq yozilmasa HECH NARSA o'chirilmaydi: skript avval
 *     qaysi server va bazaga ulanganini ko'rsatadi.
 *   - Hammasi bitta tranzaksiyada: yarmida yiqilsa hech narsa o'zgarmaydi.
 *   - OLDIN TO'LIQ BACKUP: pg_dump (SERVER.md). Skript backupni o'zi
 *     qilmaydi va buni tekshira olmaydi.
 *
 * NIMA O'CHIRILADI (test bronlari)
 *   bronlar, to'lovlar, qo'shimcha xizmatlar, mehmonlar, xarajatlar,
 *   tozalash topshiriqlari, availability keshi, xona yopilishlari
 *   (STOP faol bo'lsa, davriy vazifa 15 daqiqada qayta yopadi)
 *
 * NIMA QOLADI
 *   narxlar (RatePlan, so'mda), xodimlar va maoshlar, sozlamalar
 *   (nonushta narxi, STOP holati), xonalar, qavatlar, xona turlari,
 *   foydalanuvchilar, bot ruxsatlari, audit jurnali
 *
 * NIMA O'ZGARTIRILADI
 *   - xonalar holati -> AVAILABLE (xizmatdan chiqarilganlar qoladi)
 */

import { prisma } from "../src/lib/prisma.js";

function dbTarget(): { host: string; name: string } {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return { host: `${u.hostname}:${u.port || "5432"}`, name: u.pathname.replace(/^\//, "") };
  } catch {
    return { host: "?", name: "?" };
  }
}

async function main() {
  const { host, name } = dbTarget();
  const confirm = process.argv.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);

  console.log(`\n  Test ma'lumotlarini tozalash`);
  console.log(`  Baza: ${name} @ ${host}\n`);

  const counts = await Promise.all([
    prisma.reservation.count(),
    prisma.payment.count(),
    prisma.guest.count(),
    prisma.expense.count(),
  ]);
  console.log(
    `  O'chadi: ${counts[0]} bron, ${counts[1]} to'lov, ${counts[2]} mehmon, ${counts[3]} xarajat ` +
    `(narxlar va maoshlar qoladi)\n`
  );

  if (!confirm || confirm !== name) {
    console.log(`  HECH NARSA O'CHIRILMADI.`);
    console.log(`  Davom etish uchun (oldin pg_dump backup!):`);
    console.log(`    npm run data:reset -- --confirm=${name}\n`);
    process.exitCode = confirm ? 1 : 0;
    return;
  }

  const r = await prisma.$transaction(async (tx) => {
    // Tartib: ishora qiluvchilar birinchi (seed.ts bilan bir xil qoida)
    const payments = await tx.payment.deleteMany();
    const charges = await tx.charge.deleteMany();
    const expenses = await tx.expense.deleteMany();
    const cleaning = await tx.cleaningTask.deleteMany();
    const reservations = await tx.reservation.deleteMany();
    const guests = await tx.guest.deleteMany();
    const dayStatus = await tx.roomDayStatus.deleteMany();
    const availability = await tx.availability.deleteMany();

    const rooms = await tx.room.updateMany({
      where: { status: { notIn: ["OUT_OF_SERVICE", "OUT_OF_ORDER"] } },
      data: { status: "AVAILABLE" },
    });

    await tx.auditLog.create({
      data: {
        action: "settings.changed",
        entityType: "DataReset",
        after: {
          reason: "Test bronlari tozalandi",
          reservations: reservations.count, payments: payments.count,
        },
      },
    });

    return {
      payments, charges, expenses, cleaning, reservations, guests,
      dayStatus, availability, rooms,
    };
  }, { timeout: 120_000 });

  console.log(`  O'chirildi:`);
  console.log(`    bron ${r.reservations.count}, to'lov ${r.payments.count}, xizmat ${r.charges.count}, mehmon ${r.guests.count}`);
  console.log(`    xarajat ${r.expenses.count}, tozalash topshirig'i ${r.cleaning.count}`);
  console.log(`    availability ${r.availability.count}, yopiq kun ${r.dayStatus.count}`);
  console.log(`  O'zgartirildi:`);
  console.log(`    xona holati -> AVAILABLE: ${r.rooms.count} ta`);
  console.log(`  Qoldi: narxlar, maoshlar, sozlamalar\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
