# 00 — INDEX: Imron Hotel PMS × Beds24 integratsiyasi

Bu papkada **15 ta hujjat** + `schema.prisma` + `check-docs.sh` bor. Ular bitta katta TZ o'rniga ataylab
bo'lib tashlangan — har biri bitta mavzuga qat'iy chegaralangan.
Ijrochi bir vaqtning o'zida faqat **bitta** faylni ochib, o'sha fazani
tugatmasdan keyingisiga o'tmasligi kerak.

---

## ⚠️ MANBALAR IYERARXIYASI

```
TZ-ASL.md                          ← AVVAL SHU. Mijoz talabi + Q1–Q8.
00-INDEX.md                        ← siz hozir shu yerdasiz
01-ARXITEKTURA-VA-QOIDALAR.md      ← qoidalar, albatta o'qilsin
02-DATABASE-SXEMA.md               → schema.prisma (kod alohida)
03-BEDS24-API-INTEGRATSIYA.md
04-WEBHOOK-HANDLER.md              (Beds24 → PMS)
05-SYNC-QUEUE-BULLMQ.md
06-XONA-MAPPING.md
07-AVAILABILITY-VA-RATES-SYNC.md
08-RESERVATION-STATUS-VA-TOLOV.md
09-REALTIME-WEBSOCKET.md
10-SECURITY-VA-SYNCLOG.md
11-BOSQICHLAR-ROADMAP.md           ← ijro uchun asosiy hujjat
12-PMS-DAN-BEDS24-GA-SYNC.md       (PMS → Beds24)
13-WEBSITE-INTEGRATSIYA.md         (Website → PMS → Beds24)

schema.prisma                      ← Prisma schema (18 model, 8 enum)
check-docs.sh                      ← butunlik tekshiruvi
```

Agar biror texnik hujjat `TZ-ASL.md` ga zid kelsa — **TZ to'g'ri**,
hujjat xato va tuzatilishi kerak.

`TZ-ASL.md` oxirida mijozdan olingan **8 ta aniq qaror** (Q1–Q8) bor —
ular ham TZ bilan bir xil kuchga ega.

---

## O'qish va bajarish tartibi

```
TZ-ASL.md                          ← AVVAL SHU. Mijoz talabi.
00-INDEX.md                        ← siz hozir shu yerdasiz
[01](01-ARXITEKTURA-VA-QOIDALAR.md)      ← qoidalar, albatta o'qilsin
[02](02-DATABASE-SXEMA.md)
[03](03-BEDS24-API-INTEGRATSIYA.md)
[04](04-WEBHOOK-HANDLER.md)              (Beds24 → PMS)
[05](05-SYNC-QUEUE-BULLMQ.md)
[06](06-XONA-MAPPING.md)
[07](07-AVAILABILITY-VA-RATES-SYNC.md)
[08](08-RESERVATION-STATUS-VA-TOLOV.md)
[09](09-REALTIME-WEBSOCKET.md)
[10](10-SECURITY-VA-SYNCLOG.md)
[11](11-BOSQICHLAR-ROADMAP.md)           ← ijro uchun asosiy hujjat
[12](12-PMS-DAN-BEDS24-GA-SYNC.md)       (PMS → Beds24)
[13](13-WEBSITE-INTEGRATSIYA.md)         (Website → PMS → Beds24)
```

`[11](11-BOSQICHLAR-ROADMAP.md)` — ijro uchun asosiy hujjat. Qolganlari
unga "bilim bazasi" bo'lib xizmat qiladi.

### Uch yo'nalish — uch hujjat

TZ uchta ma'lumot oqimini talab qiladi, har biri alohida hujjatda:

| Yo'nalish | TZ bandi | Hujjat |
|---|---|---|
| Beds24 → PMS | 1, 4 | `[04](04-WEBHOOK-HANDLER.md)` |
| PMS → Beds24 | 2, 6, 7 | `[12](12-PMS-DAN-BEDS24-GA-SYNC.md)` |
| Website → PMS → Beds24 | 3 | `[13](13-WEBSITE-INTEGRATSIYA.md)` |

---

## ⚙️ ISH CHEGARASI

Bizda Beds24 hisobiga ulanish huquqi **yo'q**. Shunga qaramay tizim
**to'liq ishlaydigan holatda** topshiriladi — Beds24 moduli ham yoziladi
va mock server bilan uchdan-uchgacha test qilinadi.

| Biz yozamiz | Dasturchi qiladi |
|---|---|
| Butun backend + PostgreSQL + Prisma | `.env` ga credentials qo'yadi |
| Ichki REST API (Shaxmatka) | `npm run beds24:connect` ishga tushiradi |
| Public API (Website) | Beds24 panelida webhook URL kiritadi |
| WebSocket server | Mapping ekranida turlarni bog'laydi (3 klik) |
| BullMQ + barcha worker'lar | Deploy qiladi |
| `services/beds24/*` — to'liq modul | |
| Mock Beds24 server + testlar | **Kod yozmaydi** |

**Almashtirish bitta o'zgaruvchida:**

```
Test:       BEDS24_BASE_URL=http://localhost:4000
Production: BEDS24_BASE_URL=https://api.beds24.com/v2
```

Tafsilot: [11 FAZA 0.5](11-BOSQICHLAR-ROADMAP.md) (mock server),
[11 FAZA 15](11-BOSQICHLAR-ROADMAP.md) (topshirish qadamlari).

---

## Savol bo'yicha navigatsiya

| Savolingiz | Fayl |
|---|---|
| Mijoz aynan nima talab qilgan? | [TZ-ASL](TZ-ASL.md) |
| Qaysi qatlam nimaga javobgar? | [01](01-ARXITEKTURA-VA-QOIDALAR.md) |
| Qaysi jadvallar bor? | [02](02-DATABASE-SXEMA.md) → [schema.prisma](schema.prisma) |
| Beds24 API qanday ishlaydi? | [03](03-BEDS24-API-INTEGRATSIYA.md) |
| OTA'dan bron kelsa nima bo'ladi? | [04](04-WEBHOOK-HANDLER.md) |
| Navbat va retry qanday? | [05](05-SYNC-QUEUE-BULLMQ.md) |
| Xona qanday bog'lanadi? | [06](06-XONA-MAPPING.md) |
| Overbooking qanday to'xtatiladi? | [07 §5](07-AVAILABILITY-VA-RATES-SYNC.md) |
| Narxni kim belgilaydi? | [07 §8](07-AVAILABILITY-VA-RATES-SYNC.md) |
| Statuslar va to'lov? | [08](08-RESERVATION-STATUS-VA-TOLOV.md) |
| Real-time qanday ishlaydi? | [09](09-REALTIME-WEBSOCKET.md) |
| Xavfsizlik va loglar? | [10](10-SECURITY-VA-SYNCLOG.md) |
| **Qayerdan boshlayman?** | **[11](11-BOSQICHLAR-ROADMAP.md)** |
| Shaxmatka o'zgarishi Beds24'ga? | [12](12-PMS-DAN-BEDS24-GA-SYNC.md) |
| Website qanday ulanadi? | [13](13-WEBSITE-INTEGRATSIYA.md) |

**Hujjatlar butunligini tekshirish:** `./check-docs.sh`

---

## MUTLAQO QAT'IY QOIDALAR

1. **Mavjud Admin Panel, Customer Website va Shaxmatka qayta
   yasalmaydi.** Faqat backend + database + Beds24 integratsiyasi
   yaratiladi va mavjud frontendlar shu backendga ulanadi.

   *Aniqlashtirish:* "qayta yasalmaydi" — UI, dizayn, komponentlar va
   biznes-mantiq o'zgarmaydi degani. Ma'lumot manbaini almashtirish
   (`useState` → `fetch`) va WebSocket tinglovchi qo'shish bundan
   istisno — usiz integratsiya texnik jihatdan mumkin emas.
   Bundan tashqari **ikkita** aniq o'zgartirish bor:
   (a) `RES_STATUS` ga ikki status qo'shish (Q5, [08 §1](08-RESERVATION-STATUS-VA-TOLOV.md));
   (b) `PricingPanel` mazmuni narx boshqaruviga aylanadi
   (Q8, [07 §8](07-AVAILABILITY-VA-RATES-SYNC.md)).
   Boshqa hech qanday komponentga tegilmaydi.

2. Beds24 credentials **hech qachon** frontendga chiqarilmaydi —
   faqat backendda, shifrlangan holda (TZ 13, 18-band).

3. Har qanday OTA tomonlama xato **PMS ishini to'xtatmasligi** kerak —
   bron DB'ga saqlanadi, sync navbatga qo'yiladi (TZ 17, 19-band).

4. **Overbooking mutlaqo bo'lmasligi shart** (TZ 3-band) — himoya
   database darajasida, `EXCLUDE USING gist` constraint bilan.

5. Xona mapping xato bo'lsa — bron noto'g'ri turga tushmasligi kerak.
   Mapping yo'q bo'lsa sync **rad etiladi**, taxminiy mapping
   **aslo** ishlatilmaydi (TZ 5-band).

6. Arxitektura faqat Beds24 bilan cheklanmaydi — umumiy `Channel`
   abstraksiyasi (TZ 12-band).

7. API mavjud bo'lmagan platformalar uchun **fake API, scraping yoki
   browser automation ishlatilmaydi** (TZ 12-band).

8. Sensitive ma'lumotlar (token, parol, karta) hech qachon log
   qilinmaydi (TZ 16, 18-band).

9. Har bosqich alohida, tugallangan holda topshiriladi — bir nechta
   fazani aralashtirib yozish taqiqlanadi.

---

## Mijozdan olingan qarorlar (Q1–Q8)

TZ'da ochiq qolgan nuqtalar bo'yicha aniq javoblar. To'liq matni:
`TZ-ASL.md` oxirida.

| № | Qaror | Qayerda |
|---|---|---|
| Q1 | Xonalar Shaxmatkada **alohida** ko'rinadi; Beds24 o'z tomonida yuritadi | `06`, `07` |
| Q2 | Har xonaning **o'z ID raqami** bor → `Room.id` = `"101"` | `02` |
| Q3 | Beds24'dan kelgan bron xonaga **avtomatik** biriktiriladi | `06` §5, `04` §4 |
| Q5 | `PENDING_PAYMENT` va `NO_SHOW` Shaxmatkaga **qo'shiladi** | `08` §1 |
| Q6 | Xona almashsa — Beds24'da ham ko'rinadi | `12` §4 |
| Q7 | Check-in/check-out Beds24 bilan **sinxronlanadi** | `12` §6, `08` §5 |
| Q8 | Avtomatik o'suvchi narx **mexanizmi** olib tashlanadi; **panel UI sifatida qoladi** | [07 §8](07-AVAILABILITY-VA-RATES-SYNC.md) |

---

## Tashqi standart bo'yicha aniqlangan haqiqat

Booking.com / Airbnb / Expedia bilan to'g'ridan-to'g'ri
sertifikatlashuv **kerak emas** — Beds24 bu OTA'lar bilan allaqachon
sertifikatlangan channel manager. Yagona tashqi integratsiya nuqtasi —
**Beds24 API v2** (`api.beds24.com/v2`).

Shuning uchun butun arxitektura Beds24'ning haqiqiy texnik
chegaralariga moslangan (auth, 5 daqiqalik kredit limiti, webhook,
payload cheklovlari) — tafsilot `[03](03-BEDS24-API-INTEGRATSIYA.md)`.

---

## Mavjud Shaxmatka kodi haqida

Yuklangan frontend (`index (7).html`, 1201 qator) — sof client-side
React, backend bilan bog'lanmagan. Barcha ma'lumot `useState` da.

Mavjud `Reservation` maydonlari:

```
id, roomId, guestName, phone, checkIn, checkOut, adults, children,
source, pricePerNight, notes, withMeal, status, charges[],
payments[], createdAt
```

`Room` maydonlari: `id, number, type, floor, status` — bunda
**`id` = xona raqami** (`"101"`), bu mijoz qarori Q2 bilan mos.

Seed: 12 xona — standard **6** ta, double **4** ta, deluxe **2** ta.
Bu sonlar availability agregatsiyasi uchun asos ([07 §2](07-AVAILABILITY-VA-RATES-SYNC.md)).

Backend API javobi shu shaklga moslanadi — to'liq moslik jadvali:
`[02](02-DATABASE-SXEMA.md)` §3.

---

## Nima bu hujjatlar to'plamiga KIRMAYDI

- Admin Panel / Website / Shaxmatka UI qayta dizayni
- OTA'lar bilan to'g'ridan-to'g'ri integratsiya (Beds24 zimmasida)
- To'lov provayderi (Payme/Click/Stripe) integratsiyasi — TZ 14-band
  faqat **Beds24'dan kelgan** to'lovni bog'lashni talab qiladi
  ([13 §7](13-WEBSITE-INTEGRATSIYA.md))
- Mobil ilova, push-notification — TZ'da yo'q
