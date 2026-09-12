/**
 * Seed — boshlang'ich ma'lumotlar
 *
 * Manba: 02-DATABASE-SXEMA.md §4
 * Shaxmatka frontendidagi buildRooms() va buildSeedReservations()
 * bilan AYNAN bir xil: 12 xona, standard 6 / double 4 / deluxe 2.
 *
 * Ishga tushirish:  npm run db:seed
 */

import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Bugundan N kun keyingi sana (soat 00:00)
const day = (n: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};

const dec = (n: number) => new Prisma.Decimal(n);

async function main() {
  console.log("Seed boshlandi...\n");

  // --- Tozalash (bog'liqlik tartibida) ----------------------
  await prisma.payment.deleteMany();
  await prisma.charge.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.guest.deleteMany();
  await prisma.availability.deleteMany();
  await prisma.roomDayStatus.deleteMany();
  await prisma.ratePlan.deleteMany();
  await prisma.channelMapping.deleteMany();
  await prisma.room.deleteMany();
  await prisma.roomType.deleteMany();
  await prisma.syncLog.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.syncState.deleteMany();
  await prisma.channelConnection.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.settings.deleteMany();

  // --- RoomType (Shaxmatkadagi ROOM_TYPES bilan bir xil) ----
  await prisma.roomType.createMany({
    data: [
      { id: "standard", label: "Standart", multiplier: 1.0, sortOrder: 1 },
      { id: "double", label: "Ikki kishilik", multiplier: 1.2, sortOrder: 2 },
      { id: "deluxe", label: "Lyuks", multiplier: 1.5, sortOrder: 3 },
    ],
  });
  console.log("  RoomType: 3 ta");

  // --- Room (buildRooms() bilan aynan bir xil) --------------
  // Room.id = xona raqami (mijoz qarori Q2)
  const layout: Array<[string, string, number]> = [
    ["101", "standard", 1], ["102", "standard", 1], ["103", "double", 1],
    ["104", "double", 1],   ["105", "standard", 1], ["106", "deluxe", 1],
    ["107", "standard", 2], ["108", "double", 2],   ["109", "standard", 2],
    ["110", "deluxe", 2],   ["111", "standard", 2], ["112", "double", 2],
  ];

  await prisma.room.createMany({
    data: layout.map(([number, roomTypeId, floor], i) => ({
      id: number,
      number,
      floor,
      roomTypeId,
      status: "AVAILABLE" as const,
      sortOrder: i,
    })),
  });

  const counts = layout.reduce<Record<string, number>>((acc, [, t]) => {
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  Room: 12 ta — standard ${counts.standard}, double ${counts.double}, deluxe ${counts.deluxe}`
  );

  // 02-DATABASE-SXEMA.md §4 kutgan sonlar
  if (counts.standard !== 6 || counts.double !== 4 || counts.deluxe !== 2) {
    throw new Error(
      `Seed raqamlari hujjatga zid! Kutilgan 6/4/2, olindi ` +
      `${counts.standard}/${counts.double}/${counts.deluxe}`
    );
  }

  // --- Channel (TZ 12-band: kelajakda boshqalar qo'shiladi) -
  const beds24 = await prisma.channel.create({
    data: { code: "beds24", name: "Beds24", isActive: true },
  });
  console.log("  Channel: beds24");

  // --- Settings (TZ 7-band: source-of-truth) ---------------
  await prisma.settings.createMany({
    data: [
      { key: "SOURCE_OF_TRUTH_RATES", value: "pms" },
      { key: "SOURCE_OF_TRUTH_AVAILABILITY", value: "pms" },
      { key: "PENDING_PAYMENT_TIMEOUT_HOURS", value: "24" },
    ],
  });
  console.log("  Settings: 3 ta");

  // --- User (TZ 18-band: RBAC) ------------------------------
  //
  // Uchala rol ham yaratiladi: RBAC testlari uchun kerak va
  // dasturchi topshirishda har rolni sinab ko'ra oladi.
  //
  // DEV PAROLLARI. Topshirishda birinchi qadam — ularni
  // o'zgartirish (FAZA 15 ro'yxatida).
  const devPassword = await bcrypt.hash("admin12345", 10);

  await prisma.user.createMany({
    data: [
      { email: "admin@imron.local",   passwordHash: devPassword, fullName: "Administrator", role: "ADMIN" },
      { email: "manager@imron.local", passwordHash: devPassword, fullName: "Menejer",       role: "MANAGER" },
      { email: "staff@imron.local",   passwordHash: devPassword, fullName: "Qabulxona",     role: "STAFF" },
    ],
  });
  console.log("  User: 3 ta (admin/manager/staff, parol: admin12345)");

  // --- RatePlan (30 kunga, TZ 7-band) -----------------------
  const basePrices: Record<string, number> = {
    standard: 35, double: 42, deluxe: 52,
  };
  const rates: Prisma.RatePlanCreateManyInput[] = [];
  for (let d = 0; d < 30; d++) {
    for (const [roomTypeId, price] of Object.entries(basePrices)) {
      rates.push({ roomTypeId, date: day(d), price: dec(price), minStay: 1, source: "pms" });
    }
  }
  await prisma.ratePlan.createMany({ data: rates });
  console.log(`  RatePlan: ${rates.length} ta (30 kun × 3 tur)`);

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

  const reservations = [
    { roomId: "101", g: 0, ci: -2, co: 3,  price: 35, src: "DIRECT",      st: "CHECKED_IN",  paid: 175, method: "Naqd" },
    { roomId: "103", g: 1, ci: 1,  co: 4,  price: 40, src: "PHONE",       st: "CONFIRMED",   paid: 40,  method: "Karta" },
    { roomId: "104", g: 2, ci: -1, co: 2,  price: 38, src: "BOOKING_COM", st: "CHECKED_IN",  paid: 114, method: "Onlayn" },
    { roomId: "106", g: 3, ci: 0,  co: 5,  price: 50, src: "AIRBNB",      st: "CHECKED_IN",  paid: 150, method: "Onlayn" },
    { roomId: "108", g: 4, ci: -3, co: -1, price: 30, src: "WALK_IN",     st: "CHECKED_OUT", paid: 60,  method: "Naqd" },
    { roomId: "110", g: 5, ci: -1, co: 4,  price: 42, src: "DIRECT",      st: "CHECKED_IN",  paid: 100, method: "Naqd" },
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
        currency: "USD",
        status: r.st,
        checkedInAt: r.st === "CHECKED_IN" || r.st === "CHECKED_OUT" ? day(r.ci) : null,
        checkedOutAt: r.st === "CHECKED_OUT" ? day(r.co) : null,
        syncStatus: "NOT_APPLICABLE",
        payments: {
          create: { amount: dec(r.paid), method: r.method, paymentDate: day(r.ci) },
        },
      },
    });
  }
  console.log(`  Reservation: ${reservations.length} ta (to'lovlari bilan)`);

  // --- Room.status bronlarga qarab yangilanadi --------------
  // roomStatusForReservation() mantig'i (08-fayl §1)
  const statusMap: Record<string, "OCCUPIED" | "DIRTY" | "RESERVED"> = {
    CHECKED_IN: "OCCUPIED",
    CHECKED_OUT: "DIRTY",
    CONFIRMED: "RESERVED",
    PENDING_PAYMENT: "RESERVED",
  };
  for (const r of reservations) {
    const st = statusMap[r.st];
    if (st) await prisma.room.update({ where: { id: r.roomId }, data: { status: st } });
  }

  // --- Availability (07-fayl §2 agregatsiyasi) --------------
  const rooms = await prisma.room.findMany({ where: { isActive: true } });
  const avail: Prisma.AvailabilityCreateManyInput[] = [];

  for (let d = 0; d < 30; d++) {
    const date = day(d);
    for (const roomTypeId of ["standard", "double", "deluxe"]) {
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
  console.log(`  Availability: ${avail.length} ta (30 kun × 3 tur)`);

  // --- Yakuniy tekshiruv ------------------------------------
  const today = avail.filter((a) => a.date.getTime() === day(0).getTime());
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
  });
