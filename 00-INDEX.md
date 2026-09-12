# 00 — INDEX: Imron Hotel PMS × Beds24 integratsiyasi

Bu papkada **15 ta hujjat** bor. Ular bitta katta TZ o'rniga ataylab
bo'lib tashlangan — har biri bitta mavzuga qat'iy chegaralangan.
Ijrochi bir vaqtning o'zida faqat **bitta** faylni ochib, o'sha fazani
tugatmasdan keyingisiga o'tmasligi kerak.

---

## ⚠️ MANBALAR IYERARXIYASI

```
TZ-ASL.md                    ← MIJOZ TZ'si. Eng yuqori kuchga ega.
    ↓                          Ziddiyat bo'lsa — SHU G'OLIB.
01…13 texnik hujjatlar       ← TZ'ning texnik yoyilmasi.
                               TZ'ni kuchsizlantirmaydi, o'rnini bosmaydi.
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
01-ARXITEKTURA-VA-QOIDALAR.md      ← qoidalar, albatta o'qilsin
02-DATABASE-SXEMA.md
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
```

`11-BOSQICHLAR-ROADMAP.md` — ijro uchun asosiy hujjat. Qolganlari
unga "bilim bazasi" bo'lib xizmat qiladi.

### Uch yo'nalish — uch hujjat

TZ uchta ma'lumot oqimini talab qiladi, har biri alohida hujjatda:

| Yo'nalish | TZ bandi | Hujjat |
|---|---|---|
| Beds24 → PMS | 1, 4 | `04-WEBHOOK-HANDLER.md` |
| PMS → Beds24 | 2, 6, 7 | `12-PMS-DAN-BEDS24-GA-SYNC.md` |
| Website → PMS → Beds24 | 3 | `13-WEBSITE-INTEGRATSIYA.md` |

---

## MUTLAQO QAT'IY QOIDALAR

1. **Mavjud Admin Panel, Customer Website va Shaxmatka qayta
   yasalmaydi.** Faqat backend + database + Beds24 integratsiyasi
   yaratiladi va mavjud frontendlar shu backendga ulanadi.

   *Aniqlashtirish:* "qayta yasalmaydi" — UI, dizayn, komponentlar va
   biznes-mantiq o'zgarmaydi degani. Ma'lumot manbaini almashtirish
   (`useState` → `fetch`) va WebSocket tinglovchi qo'shish bundan
   istisno — usiz integratsiya texnik jihatdan mumkin emas. Yagona
   boshqa o'zgartirish: `RES_STATUS` ga ikki status qo'shish
   (mijoz qarori Q5).

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
| Q8 | Dinamik narxlash **olib tashlanadi** — narxni admin qo'lda qo'yadi | `07` §8 |

---

## Tashqi standart bo'yicha aniqlangan haqiqat

Booking.com / Airbnb / Expedia bilan to'g'ridan-to'g'ri
sertifikatlashuv **kerak emas** — Beds24 bu OTA'lar bilan allaqachon
sertifikatlangan channel manager. Yagona tashqi integratsiya nuqtasi —
**Beds24 API v2** (`api.beds24.com/v2`).

Shuning uchun butun arxitektura Beds24'ning haqiqiy texnik
chegaralariga moslangan (auth, 5 daqiqalik kredit limiti, webhook,
payload cheklovlari) — tafsilot `03-BEDS24-API-INTEGRATSIYA.md`.

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
Bu sonlar availability agregatsiyasi uchun asos (`07`-fayl §2).

Backend API javobi shu shaklga moslanadi — to'liq moslik jadvali:
`02-DATABASE-SXEMA.md` §3.

---

## Nima bu hujjatlar to'plamiga KIRMAYDI

- Admin Panel / Website / Shaxmatka UI qayta dizayni
- OTA'lar bilan to'g'ridan-to'g'ri integratsiya (Beds24 zimmasida)
- To'lov provayderi (Payme/Click/Stripe) integratsiyasi — TZ 14-band
  faqat **Beds24'dan kelgan** to'lovni bog'lashni talab qiladi
  (`13`-fayl §7)
- Mobil ilova, push-notification — TZ'da yo'q
