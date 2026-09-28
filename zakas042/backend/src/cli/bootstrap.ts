/**
 * Production boshlang'ich ma'lumoti — BO'SH bazaga (2026-09-28)
 *
 * Seed (`prisma/seed.ts`) test uchun: bazani tozalaydi, namuna bronlar,
 * soxta xodimlar va `admin12345` parolli 4 ta hisob yaratadi. Production'ga
 * yaramaydi. Bu skript faqat kerakli minimumni yozadi:
 *
 *   - qavatlar, 9 tarif, 18 xona (src/lib/hotelLayout.ts)
 *   - bitta FOUNDER hisobi — qolgan xodimlarni egasi admin panelda qo'shadi
 *
 * Bron, mehmon, xodim, narx YOZILMAYDI. Narxni admin Narxlar bo'limida
 * kiritadi yoki Beds24 ulangach tur darajasidagi tarif narxi o'zi
 * tortiladi (BEDS24.md 1-bo'lim).
 *
 * Takror ishga tushirish xavfsiz: tuzilma bor bo'lsa — tegmaydi,
 * foydalanuvchi bor bo'lsa — hisob yaratilmaydi. Hech narsa o'chirilmaydi.
 *
 * Ishga tushirish (serverda):
 *   docker compose exec api node dist/cli/bootstrap.js
 *
 * Muhit:
 *   BOOTSTRAP_EMAIL     — FOUNDER login'i (standart founder@imron.local)
 *   BOOTSTRAP_PASSWORD  — kamida 12 belgi; berilmasa tasodifiy parol
 *                         yaratiladi va BIR MARTA ekranga chiqadi
 */

import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { createHotelStructure } from "../lib/hotelLayout.js";
import { hashPassword } from "../services/auth.js";

const MIN_PASSWORD = 12;

async function main(): Promise<void> {
  // Avval tekshiruv — xato bo'lsa bazaga hech narsa yozilmasin
  const email = (process.env.BOOTSTRAP_EMAIL ?? "founder@imron.local").trim().toLowerCase();
  const given = process.env.BOOTSTRAP_PASSWORD ?? "";
  if (given && given.length < MIN_PASSWORD) {
    throw new Error(`BOOTSTRAP_PASSWORD kamida ${MIN_PASSWORD} belgi bo'lishi kerak`);
  }

  const rooms = await prisma.room.count();
  if (rooms === 0) {
    const made = await createHotelStructure(prisma);
    console.log(`Tuzilma yaratildi: ${made.floors} qavat, ${made.roomTypes} tarif, ${made.rooms} xona`);
  } else {
    console.log(`Tuzilma bor (${rooms} xona) — tegilmadi`);
  }

  const users = await prisma.user.count();
  if (users > 0) {
    console.log(`Foydalanuvchilar bor (${users} ta) — yangi hisob yaratilmadi`);
    return;
  }

  const password = given || randomBytes(12).toString("base64url");

  await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      fullName: "Egasi",
      role: "FOUNDER",
    },
  });

  console.log(`FOUNDER yaratildi: ${email}`);
  if (!given) {
    console.log(`Parol (bir marta ko'rsatiladi, kirgach almashtiring): ${password}`);
  }
}

main()
  .catch((e) => {
    console.error("Boshlang'ich ma'lumot yozilmadi:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
