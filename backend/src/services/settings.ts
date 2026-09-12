/**
 * Sozlamalar — TZ 7-band (source of truth)
 *
 * Manba: 07-AVAILABILITY-VA-RATES-SYNC.md §7
 *
 * NEGA DB'DA, `.env` DA EMAS: `SOURCE_OF_TRUTH_RATES` ishlash
 * paytida o'zgarishi mumkin (admin panelda tugma). `.env` o'zgarishi
 * server qayta ishga tushirilishini talab qiladi, bu esa ishlab
 * turgan mehmonxonada qabul qilib bo'lmaydigan narsa.
 *
 * `.env` qiymati BOSHLANG'ICH qiymat sifatida ishlatiladi: DB'da
 * yozuv bo'lmasa o'sha olinadi.
 */

import { prisma } from "../lib/prisma.js";
import { config } from "../lib/config.js";

export type SourceOfTruth = "pms" | "beds24";

export const SETTING_KEYS = {
  ratesSoT: "SOURCE_OF_TRUTH_RATES",
  availabilitySoT: "SOURCE_OF_TRUTH_AVAILABILITY",
} as const;

/**
 * Sozlamani o'qiydi.
 *
 * KESHLANMAYDI: admin qiymatni o'zgartirganda barcha worker'lar
 * darhol yangi qiymatni ko'rishi kerak. Narx sync'i baribir tashqi
 * API kutadi, bitta indeksli so'rov sezilmaydi.
 */
export async function getSetting(key: string, fallback: string): Promise<string> {
  try {
    const row = await prisma.settings.findUnique({ where: { key } });
    return row?.value ?? fallback;
  } catch {
    // DB yiqilsa ham sync to'xtamasin (TZ 17-band)
    return fallback;
  }
}

export async function setSetting(
  key: string,
  value: string,
  updatedBy?: string
): Promise<void> {
  await prisma.settings.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
}

/**
 * Narx uchun source of truth (TZ 7-band).
 *
 * "pms"    — PMS narxi Beds24'ga yuboriladi, Beds24'dan kelgan
 *            narx RAD ETILADI (va qayta yozib yuborilmaydi ham —
 *            aks holda cheksiz halqa)
 * "beds24" — teskarisi
 */
export async function getRatesSoT(): Promise<SourceOfTruth> {
  const v = await getSetting(SETTING_KEYS.ratesSoT, config.sourceOfTruth.rates);
  return v === "beds24" ? "beds24" : "pms";
}

export async function getAvailabilitySoT(): Promise<SourceOfTruth> {
  const v = await getSetting(SETTING_KEYS.availabilitySoT, config.sourceOfTruth.availability);
  return v === "beds24" ? "beds24" : "pms";
}

/** Admin panel uchun — joriy sozlamalar */
export async function listSettings() {
  const rows = await prisma.settings.findMany({ orderBy: { key: "asc" } });
  const map = new Map(rows.map((r) => [r.key, r]));

  return {
    ratesSoT: await getRatesSoT(),
    availabilitySoT: await getAvailabilitySoT(),
    /** `.env` dan olinganmi yoki DB'da o'rnatilganmi */
    overrides: {
      ratesSoT: map.has(SETTING_KEYS.ratesSoT),
      availabilitySoT: map.has(SETTING_KEYS.availabilitySoT),
    },
    updatedAt: {
      ratesSoT: map.get(SETTING_KEYS.ratesSoT)?.updatedAt ?? null,
      availabilitySoT: map.get(SETTING_KEYS.availabilitySoT)?.updatedAt ?? null,
    },
  };
}
