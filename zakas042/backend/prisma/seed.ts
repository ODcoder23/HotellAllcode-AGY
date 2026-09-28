/**
 * Seed — boshlang'ich ma'lumotlar
 *
 * Xona ro'yxati mijozdan olingan (2026-09-16):
 * 18 xona (3 qavat x 6), 9 tarif. Narxlar so'mda.
 *
 * Ishga tushirish:  npm run db:seed
 */

import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { recalcAllRoomStatuses } from "../src/services/roomStatus.js";
import { prisma as appPrisma } from "../src/lib/prisma.js";
import { HOTEL_ROOM_TYPES, HOTEL_ROOMS, createHotelStructure } from "../src/lib/hotelLayout.js";

const prisma = new PrismaClient();

/**
 * Bugundan N kun keyingi sana — Toshkent kuni, UTC yarim tuni
 * (`@db.Date` va src/lib/hotelTime.ts bilan bir xil o'lchov).
 *
 * Ilgari `setHours(0)` edi: mahalliy yarim tun UTC da kechagi kun
 * (Toshkentda 19:00), `@db.Date` uni kechagi sana qilib yozardi —
 * seed'dagi "bugungi" bronlar kecha boshlangan bo'lib chiqardi.
 */
const day = (n: number): Date => {
  const t = new Date(Date.now() + 5 * 3_600_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + n));
};

const dec = (n: number) => new Prisma.Decimal(n);

/**
 * Seed BAZANI TOZALAYDI. Ishlab chiqarish bazasida tasodifan ishga
 * tushmasin: baza nomida "test" yo'q va bronlar bor bo'lsa —
 * `SEED_ALLOW_WIPE=true` talab qilinadi (yangi, bo'sh bazada kerak emas).
 */
async function assertSafeToWipe(): Promise<void> {
  if (process.env.SEED_ALLOW_WIPE === "true") return;
  let name = "";
  try { name = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""); } catch { /* bo'sh */ }
  if (/test/i.test(name)) return;
  const bookings = await prisma.reservation.count().catch(() => 0);
  if (bookings === 0) return;
  throw new Error(
    `Seed "${name}" bazasini tozalaydi, unda ${bookings} ta bron bor. ` +
    `Ataylab bo'lsa: SEED_ALLOW_WIPE=true npm run db:seed (oldin pg_dump!)`
  );
}

async function main() {
  await assertSafeToWipe();
  console.log("Seed boshlandi...\n");

  // --- Tozalash (bog'liqlik tartibida) ----------------------
  //
  // TARTIB MUHIM: har jadval o'ziga ishora qiluvchilardan KEYIN
  // o'chiriladi, aks holda foreign key xatosi chiqadi.
  //
  // `CleaningTask`, `Expense`, `BotAccess` 2026-09-17 da qo'shildi
  // (tozalik va moliya bo'limlari). Ular ro'yxatga kiritilmagani
  // uchun seed butunlay ishlamay qolgan edi:
  //   P2003 — CleaningTask_roomId_fkey
  // Natijada baza yarim tozalangan holatda qolardi: xonalar va
  // tariflar bor, narxlar esa yo'q — sayt bo'sh ro'yxat qaytarardi.
  // Beds24: ChannelMapping va ChannelBlock Room/RoomType ga ishora
  // qiladi — xonalardan OLDIN. Ulanish (shifrlangan token) ham tozalanadi
  await prisma.channelMapping.deleteMany();
  await prisma.channelBlock.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.syncLog.deleteMany();
  await prisma.syncState.deleteMany();
  await prisma.channelConnection.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.charge.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.guest.deleteMany();
  await prisma.availability.deleteMany();
  await prisma.roomDayStatus.deleteMany();
  await prisma.ratePlan.deleteMany();
  await prisma.cleaningTask.deleteMany();   // Room, User, Employee ga ishora qiladi
  await prisma.expense.deleteMany();        // User ga ishora qiladi
  await prisma.botAccess.deleteMany();
  await prisma.room.deleteMany();
  await prisma.floor.deleteMany();   // Room dan KEYIN: Room.floorId unga ishora qiladi
  await prisma.roomType.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.settings.deleteMany();

  // --- Tuzilma: tarif, qavat, xona (src/lib/hotelLayout.ts) ---
  // Ro'yxat production boshlang'ich skripti bilan umumiy — bitta manba.
  // Narxlar (`price`) namunaviy, haqiqiysini admin Narxlar panelida
  // belgilaydi.
  const roomTypes = HOTEL_ROOM_TYPES;
  const made = await createHotelStructure(prisma);
  const counts = HOTEL_ROOMS.reduce<Record<string, number>>((acc, [, t]) => {
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  RoomType: ${made.roomTypes} ta`);
  console.log(`  Floor: ${made.floors} ta`);
  console.log(
    `  Room: ${made.rooms} ta — ` +
    roomTypes.map((rt) => `${rt.id} ${counts[rt.id] ?? 0}`).join(", ")
  );

  // --- Settings ---------------------------------------------
  // `skipDuplicates`: sozlamani backend ham yozishi mumkin
  // (`services/settings.ts`) — seed bilan bir vaqtda ishlasa poyga.
  await prisma.settings.createMany({
    data: [
      // Nonushta, kishi boshiga so'm — namunaviy (haqiqiysini admin
      // Oshxona bo'limida belgilaydi)
      { key: "MEAL_PRICE_PER_PERSON", value: "25000" },
    ],
    skipDuplicates: true,
  });
  console.log("  Settings: 1 ta");

  // --- User (TZ 18-band: RBAC) ------------------------------
  //
  // Uchala rol ham yaratiladi: RBAC testlari uchun kerak va
  // dasturchi topshirishda har rolni sinab ko'ra oladi.
  //
  // DEV PAROLLARI. Topshirishda birinchi qadam — ularni
  // o'zgartirish.
  const devPassword = await bcrypt.hash("admin12345", 10);

  await prisma.user.createMany({
    data: [
      { email: "founder@imron.local", passwordHash: devPassword, fullName: "Egasi",         role: "FOUNDER" },
      { email: "admin@imron.local",   passwordHash: devPassword, fullName: "Administrator", role: "ADMIN" },
      { email: "manager@imron.local", passwordHash: devPassword, fullName: "Menejer",       role: "MANAGER" },
      { email: "staff@imron.local",   passwordHash: devPassword, fullName: "Qabulxona",     role: "STAFF" },
    ],
  });
  console.log("  User: 4 ta (founder/admin/manager/staff, parol: admin12345)");

  // --- Employee (kadrlar hisobi) ----------------------------
  //
  // `User` dan farqli: bu mehmonxonada ishlaydigan odamlar.
  // Farrosh va oshpaz tizimga kirmaydi, lekin ular ham xodim.
  const staffUser = await prisma.user.findUnique({ where: { email: "staff@imron.local" } });

  const employees = [
    // Oylik maosh so'mda (Q15) — namunaviy
    { fullName: "Aziz Rustamov",      position: "Bosh administrator", salary: 6_000_000, months: 36 },
    { fullName: "Dilnoza Yoqubova",   position: "Qabulxona xodimi",   salary: 3_500_000, months: 18 },
    { fullName: "Shahzod Qodirov",    position: "Qabulxona xodimi",   salary: 3_500_000, months: 12 },
    { fullName: "Malika Ismoilova",   position: "Farrosh",            salary: 2_500_000, months: 24 },
    { fullName: "Rustam Bekmurodov",  position: "Farrosh",            salary: 2_500_000, months: 8 },
    { fullName: "Farrux Toirov",      position: "Oshpaz",             salary: 4_000_000, months: 30 },
    { fullName: "Nodira Karimova",    position: "Oshpaz yordamchisi", salary: 2_800_000, months: 6 },
    { fullName: "Bekzod Umarov",      position: "Xavfsizlik",         salary: 3_000_000, months: 14 },
  ];

  await prisma.employee.createMany({
    data: employees.map((e, i) => ({
      fullName: e.fullName,
      position: e.position,
      phone: `+998 9${i} ${100 + i}${i} ${10 + i} ${20 + i}`,
      salary: dec(e.salary),
      hiredAt: day(-e.months * 30),
      isActive: true,
      // Qabulxona xodimining tizim hisobi ham bor
      userId: e.fullName === "Dilnoza Yoqubova" ? staffUser?.id ?? null : null,
    })),
  });

  const salaryTotal = employees.reduce((s, e) => s + e.salary, 0);
  console.log(`  Employee: ${employees.length} ta (oylik jami ${salaryTotal.toLocaleString("ru-RU")} so'm)`);

  // --- RatePlan (TZ 7-band) ---------------------------------
  //
  // Narxlar `roomTypes` dan olinadi — tarif qo'shilsa shu yerni
  // tahrirlash kerak emas.
  //
  // DAVOMIYLIK: 365 kun. Narx tugagan kunga qidiruv "xona yo'q"
  // qaytaradi (publicBooking.ts: `if (price <= 0) continue`), shuning
  // uchun oraliq qisqa bo'lmasligi kerak.
  const RATE_DAYS = 365;
  const rates: Prisma.RatePlanCreateManyInput[] = [];
  for (let d = 0; d < RATE_DAYS; d++) {
    for (const rt of roomTypes) {
      rates.push({
        roomTypeId: rt.id,
        date: day(d),
        price: dec(rt.price),
      });
    }
  }
  await prisma.ratePlan.createMany({ data: rates });
  console.log(`  RatePlan: ${rates.length} ta (${RATE_DAYS} kun × ${roomTypes.length} tarif)`);

  // --- Guest + Reservation ----------------------------------
  // buildSeedReservations() bilan bir xil 6 ta test bron
  const guests = await Promise.all([
    prisma.guest.create({ data: { fullName: "Ali Valiyev", phone: "+998 90 123 45 67" } }),
    prisma.guest.create({ data: { fullName: "Karimov", phone: "+998 91 222 33 44" } }),
    prisma.guest.create({ data: { fullName: "Booking mehmoni", phone: "+998 93 555 66 77" } }),
    prisma.guest.create({ data: { fullName: "Airbnb mehmoni", phone: "+998 94 777 88 99" } }),
    prisma.guest.create({ data: { fullName: "Sardor (bevosita)", phone: "+998 95 111 22 33" } }),
    prisma.guest.create({ data: { fullName: "Aliyev", phone: "+998 97 444 55 66" } }),
  ]);
  console.log(`  Guest: ${guests.length} ta`);

  // Namunaviy bronlar. Xona raqamlari yangi ro'yxatdan (101-106,
  // 201-206, 301-306), narxlar so'mda va tarif narxiga mos.
  const reservations = [
    { roomId: "101", g: 0, ci: -2, co: 3,  price: 450_000, src: "DIRECT",      st: "CHECKED_IN",  paid: 2_250_000, method: "Naqd" },
    { roomId: "103", g: 1, ci: 1,  co: 4,  price: 550_000, src: "PHONE",       st: "CONFIRMED",   paid: 550_000,   method: "Karta" },
    { roomId: "104", g: 2, ci: -1, co: 2,  price: 600_000, src: "BOOKING_COM", st: "CHECKED_IN",  paid: 1_800_000, method: "Onlayn" },
    { roomId: "106", g: 3, ci: 0,  co: 5,  price: 650_000, src: "AIRBNB",      st: "CHECKED_IN",  paid: 1_950_000, method: "Onlayn" },
    { roomId: "205", g: 4, ci: -3, co: -1, price: 700_000, src: "WALK_IN",     st: "CHECKED_OUT", paid: 1_400_000, method: "Naqd" },
    { roomId: "301", g: 5, ci: -1, co: 4,  price: 800_000, src: "DIRECT",      st: "CHECKED_IN",  paid: 2_000_000, method: "Naqd" },
  ] as const;

  for (const r of reservations) {
    await prisma.reservation.create({
      data: {
        roomId: r.roomId,
        guestId: guests[r.g].id,
        checkIn: day(r.ci),
        checkOut: day(r.co),
        adults: 2,
        children: 0,
        source: r.src,
        pricePerNight: dec(r.price),
        status: r.st,
        checkedInAt: r.st === "CHECKED_IN" || r.st === "CHECKED_OUT" ? day(r.ci) : null,
        checkedOutAt: r.st === "CHECKED_OUT" ? day(r.co) : null,
        payments: {
          create: { amount: dec(r.paid), method: r.method, paymentDate: day(r.ci) },
        },
      },
    });
  }
  console.log(`  Reservation: ${reservations.length} ta (to'lovlari bilan)`);

  // --- Room.status bronlarga qarab yangilanadi --------------
  // Chiqqan mehmon xonasi — iflos (tozalash kutadi). Qolganini
  // services/roomStatus.ts hal qiladi: RESERVED faqat bugun keladigan
  // bron uchun. Ilgari har CONFIRMED bron xonasi (kelajakdagisi ham)
  // RESERVED qilinardi.
  for (const r of reservations) {
    if (r.st === "CHECKED_OUT") await prisma.room.update({ where: { id: r.roomId }, data: { status: "DIRTY" } });
  }
  await recalcAllRoomStatuses();

  // --- Availability ------------------------------------------
  const rooms = await prisma.room.findMany({ where: { isActive: true } });
  const avail: Prisma.AvailabilityCreateManyInput[] = [];

  for (let d = 0; d < 30; d++) {
    const date = day(d);
    for (const roomTypeId of roomTypes.map((rt) => rt.id)) {
      const totalRooms = rooms.filter((x) => x.roomTypeId === roomTypeId).length;
      const bookedRooms = await prisma.reservation.count({
        where: {
          room: { roomTypeId },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
          checkIn: { lte: date },
          checkOut: { gt: date },
        },
      });
      avail.push({
        roomTypeId,
        date,
        totalRooms,
        bookedRooms,
        blockedRooms: 0,
        availableCount: Math.max(0, totalRooms - bookedRooms),
      });
    }
  }
  await prisma.availability.createMany({ data: avail });
  console.log(`  Availability: ${avail.length} ta (30 kun × ${roomTypes.length} tarif)`);

  // --- Yakuniy tekshiruv ------------------------------------
  const today = avail.filter((a) => new Date(a.date).getTime() === day(0).getTime());
  console.log("\nBugungi availability:");
  for (const a of today) {
    console.log(
      `  ${a.roomTypeId.padEnd(9)} ${a.availableCount}/${a.totalRooms} bo'sh`
    );
  }

  console.log("\nSeed tugadi.");
}

/**
 * Seed'ni qayta urinish bilan ishga tushiradi.
 *
 * NEGA KERAK: testlar ishlayotganda server ham DB bilan ishlaydi
 * (worker'lar, WebSocket, davriy vazifalar). Seed `deleteMany`
 * qilayotganda worker o'sha qatorga tegib qolsa - deadlock yoki
 * serialization xatosi chiqadi. Bu o'tkinchi holat: bir necha yuz
 * millisekunddan keyin qayta urinish o'tadi.
 *
 * Aks holda butun test yurishi sababsiz yiqiladi va sabab
 * "PrismaClientUnknownRequestError" degan tushunarsiz xabar bo'ladi
 * (bir marta kuzatilgan: 26 test birdan qulagan).
 */
async function runWithRetry(attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await main();
      return;
    } catch (e) {
      if (i === attempts) throw e;
      console.warn(`\nSeed urinish ${i}/${attempts} yiqildi, qayta urinamiz...`);
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

runWithRetry()
  .catch((e) => {
    console.error("\nSeed XATOSI:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await appPrisma.$disconnect();   // recalcAllRoomStatuses ilova klientidan foydalanadi
  });
