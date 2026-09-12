# 13 — Customer Website → PMS → Beds24

> **Manba:** `TZ-ASL.md` **3-band** (Website → PMS → Beds24 → OTA oqimi),
> **20-band** (yakuniy natija: "Mijoz Website'dan bron qilsa → Shaxmatkada
> ko'rinsin → xona band bo'lsin → Beds24ga yuborilsin → OTA availability
> yangilansin").

TZ 3-bandi Website oqimini **aniq talab qiladi** va 20-band uni
yakuniy natijaning birinchi bandi sifatida qaytaradi. Shuning uchun
bu ish scope ichida.


**Bu fayl javob beradi:**

- Saytdan bron qilinsa nima bo'ladi?
- Mehmon qaysi xonani oladi?
- To'lanmagan bron qancha turadi?
- Public API qanday himoyalangan?

---

## 1. Nima uchun alohida API kerak

Website — **autentifikatsiyasiz, ommaviy** kirish nuqtasi. Shaxmatka
API'sidan tubdan farq qiladi:

| | Shaxmatka API | Website API |
|---|---|---|
| Kim ishlatadi | tizimga kirgan xodim | noma'lum mehmon |
| Autentifikatsiya | JWT majburiy | yo'q |
| Ko'radigan ma'lumot | barcha bronlar, mehmon ismlari, to'lovlar | faqat "bo'sh/band" |
| Xona tanlash | admin aniq xonani tanlaydi | tur tanlaydi, xona avtomatik |
| Rate limiting | yumshoq | qat'iy (bot himoyasi) |
| Narx | qo'lda o'zgartirishi mumkin | faqat serverdan |

**Xavfsizlik qoidasi:** Website API mehmonlar ismi, telefoni,
bron tafsilotlarini **hech qachon** qaytarmaydi — faqat bo'sh xonalar
soni va narx. Aks holda raqobatchi saytdan bandlik ma'lumotini
o'qib olishi mumkin.

---

## 2. Endpoint'lar

```
GET  /api/public/availability?from=2026-09-15&to=2026-09-20&adults=2
POST /api/public/reservations
GET  /api/public/reservations/:code     (bron kodi bilan tekshirish)
```

### Bo'sh xonalarni qidirish

```jsonc
// GET /api/public/availability?from=2026-09-15&to=2026-09-20&adults=2
{
  "from": "2026-09-15",
  "to": "2026-09-20",
  "nights": 5,
  "roomTypes": [
    {
      "id": "standard",
      "label": "Standart",
      "availableCount": 3,      // butun oraliq davomida bo'sh xonalar
      "pricePerNight": 35,
      "totalPrice": 175,
      "currency": "USD",
      "maxAdults": 2
    },
    { "id": "deluxe", "label": "Lyuks", "availableCount": 0, ... }
  ]
}
```

`availableCount` — [07 §2](07-AVAILABILITY-VA-RATES-SYNC.md) dagi agregatsiya, lekin **butun oraliq
bo'yicha minimal qiymat**: agar 15-da 3 ta, 17-da 1 ta bo'sh bo'lsa,
5 kunlik bron uchun javob **1** bo'ladi. Aks holda mehmon bron
qilmoqchi bo'lganda xato chiqadi.

```ts
availableForRange = Math.min(...days.map(d => d.availableCount))
```

### Bron yaratish

```jsonc
// POST /api/public/reservations
{
  "roomTypeId": "standard",       // tur, aniq xona emas
  "checkIn": "2026-09-15",
  "checkOut": "2026-09-20",
  "adults": 2,
  "children": 0,
  "guest": { "fullName": "...", "phone": "+998...", "email": "..." },
  "notes": "Kech keladi"
}
```

Javob:

```jsonc
{
  "reservationCode": "IMR-8F3K2",   // mehmonga ko'rsatiladigan kod
  "roomNumber": "102",              // avtomatik tanlangan xona
  "status": "pending_payment",
  "totalPrice": 175,
  "currency": "USD"
}
```

---

## 3. Xona avtomatik tanlash

Mehmon **turni** tanlaydi, tizim **aniq xonani** o'zi biriktiradi.
Bu Beds24'dan kelgan bron mantig'i bilan bir xil ([06 §5](06-XONA-MAPPING.md)):

```ts
function pickRoom(roomTypeId, checkIn, checkOut) {
  const candidates = rooms
    .filter(r => r.roomTypeId === roomTypeId && r.isActive)
    .filter(r => isFree(r.id, checkIn, checkOut))
    .filter(r => r.status !== "OUT_OF_ORDER" && r.status !== "OUT_OF_SERVICE")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

  return candidates[0] ?? null;   // topilmasa — bron rad etiladi
}
```

**Fragmentatsiyaning oldini olish.** Har doim birinchi bo'sh xonani
berish 5 ta xonani 5 ta yarim-band xonaga aylantirib yuborishi mumkin.
Shuning uchun tanlov tartibi: (1) shu oraliqdan oldin/keyin **qo'shni
band kunlari bor** xonalar afzal — bu uzluksiz bo'shliqlarni saqlaydi,
(2) keyin `sortOrder`.

Bu optimallashtirish FAZA 2 da soddaroq shaklda (faqat `sortOrder`)
yoziladi, keyinroq takomillashtiriladi. Funksional natija bir xil.

---

## 4. To'liq oqim (TZ 3, 20-band)

```
Mijoz Website'da "Bron qilish" bosdi
        ↓
POST /api/public/reservations
        ↓
┌────────── bitta DB transaction ──────────┐
│ 1. Turdagi bo'sh xona qidiriladi          │
│ 2. Topilmasa → 409 "Xona mavjud emas"     │
│ 3. Guest yaratiladi/topiladi (telefon)    │
│ 4. Reservation yaratiladi                 │
│      status = PENDING_PAYMENT             │
│      source = WEBSITE                     │
│ 5. reservation_no_overlap constraint      │
│    (parallel so'rovdan himoya)            │
│ 6. Room.status = RESERVED                 │
└──────────────────────────────────────────┘
        ↓
   Ikkita job + bitta event (hammasi fire-and-forget):
     a) availability-sync  → Beds24 → OTA
     b) reservation-sync   → Beds24 booking
     c) WebSocket: reservation.created → Shaxmatka
        ↓
Mijozga darhol javob: "IMR-8F3K2" + xona raqami
```

**Natija (TZ 20-band bilan solishtiring):**
- ✅ Shaxmatkada ko'rinadi — WebSocket orqali darhol
- ✅ Xona band bo'ladi — `Room.status = RESERVED` + constraint
- ✅ Beds24'ga yuboriladi — `reservation-sync`
- ✅ OTA availability yangilanadi — `availability-sync`

---

## 5. Status: `PENDING_PAYMENT`

Website'dan kelgan bron **darhol `CONFIRMED` bo'lmaydi** — mijoz hali
to'lamagan. TZ 8-bandi shu status uchun aynan shunday holatni nazarda
tutadi.

```
PENDING_PAYMENT  → mijoz bron qildi, to'lov kutilmoqda
        ↓
   (to'lov keldi yoki admin tasdiqladi)
        ↓
CONFIRMED
```

**Muhim:** `PENDING_PAYMENT` holatida ham xona **band hisoblanadi** va
availability'dan chiqariladi. Aks holda ikki mijoz bir xonani
"to'lovni kutayotgan" holatda band qilib qo'yishi mumkin.

### Avtomatik bekor qilish

To'lanmagan bron cheksiz turib qolmasligi kerak — aks holda xona
bekorga band bo'ladi:

```
Settings: PENDING_PAYMENT_TIMEOUT_HOURS = 24

Har soatda ishlaydigan repeatable job:
  PENDING_PAYMENT + createdAt > 24 soat
    → status = CANCELLED
    → Room bo'shatiladi
    → availability-sync
    → AuditLog: "auto_cancelled_unpaid"
```

Bu — TZ'da to'g'ridan-to'g'ri yozilmagan, lekin 3-bandning
("Bron qilingan xona boshqa kanallarda mavjud bo'lmagan holatga
o'tishi kerak") teskari tomoni: to'lanmagan bron abadiy band qilib
tursa, real sotuv yo'qoladi. Muddat `Settings` da o'zgartiriladi.

---

## 6. Xavfsizlik (TZ 18-band)

Ommaviy endpoint — asosiy hujum yuzasi:

| Himoya | Amalga oshirish |
|---|---|
| Rate limiting | IP bo'yicha: qidiruv 30/daqiqa, bron 5/soat |
| Bot himoyasi | CAPTCHA yoki honeypot maydon (bron formasida) |
| Validatsiya | sanalar (o'tmish emas, max 365 kun oldinga), mehmon soni, ism uzunligi |
| Ma'lumot chiqmasligi | javobda **hech qachon** boshqa mehmonlar ma'lumoti yo'q |
| Bron kodi | `IMR-XXXXX` — taxmin qilib bo'lmaydigan, ketma-ket emas |
| Spam bron | bir telefon raqamiga 24 soatda max 3 faol `PENDING_PAYMENT` |
| HTTPS | Nginx + Let's Encrypt (TZ 18-band) |

---

## 7. To'lov

TZ 14-bandi faqat **Beds24'dan kelgan** to'lov ma'lumotini PMS bilan
bog'lashni talab qiladi. To'lov provayderi (Payme/Click/Stripe)
integratsiyasi TZ'da **yo'q**.

Shuning uchun hozircha:

```
Website bron → PENDING_PAYMENT
        ↓
Mijozga: "Bronni tasdiqlash uchun qo'ng'iroq qilamiz"
        ↓
Admin to'lovni qabul qiladi → Shaxmatkada Payment qo'shadi
        ↓
status = CONFIRMED
```

Onlayn to'lov qo'shilsa — `Payment` modeli tayyor (`method: "Onlayn"`,
`externalPaymentId`), faqat provayder webhook'i ulanadi. Bu **alohida
TZ** talab qiladi.

---

## 7.1. Amalga oshirilgan holat (FAZA 13 — bajarildi)

Kod joylashuvi:

| Fayl | Vazifasi |
|------|----------|
| `backend/src/services/publicBooking.ts` | Qidiruv, xona tanlash, bron, kod, tozalash |
| `backend/src/routes/public.ts` | Uchta endpoint + honeypot |
| `backend/src/queues/scheduler.ts` | Davriy vazifa (to'lanmagan bronlar) |
| `backend/src/public.test.ts` | 33 test |

**Yangi DB maydonlari:** `Reservation.code` (unique, "IMR-XXXXX") va
`RoomType.maxAdults`. Kod `crypto.randomInt` bilan yasaladi —
ketma-ket emas, chalkashadigan belgilar (0/O, 1/I) alifbodan
chiqarilgan (mijoz kodni telefonda aytishi mumkin).

**Overbooking himoyasi qayta yozilmadi.** Public bron ham
`createReservation` orqali o'tadi — ya'ni `EXCLUDE USING gist`
constraint'i bilan himoyalangan. Website, Shaxmatka va OTA bitta
to'siqdan o'tadi. Test: 6 parallel so'rov, deluxe'da 2 xona —
ko'pi bilan 2 tasi o'tadi.

**Narxsiz tur ko'rsatilmaydi.** `RatePlan` da narx bo'lmasa tur
qidiruv natijasidan chiqariladi va bron rad etiladi. Mijozga
"0 so'm" ko'rsatib keyin haqiqiy narx aytish yomon tajriba.

**`PENDING_PAYMENT` → `CONFIRMED` yo'li ochildi.** Avval bunday
o'tish umuman yo'q edi: `PATCH /api/reservations/:id` status
maydonini qabul qilmasdi, ya'ni Website'dan kelgan bron abadiy
to'lov kutilayotgan holatda qolardi. Yangi endpoint:
`POST /api/reservations/:id/confirm`. Alohida amal qilib
yozildi — status o'zgarishi biznes hodisasi: Beds24'ga boshqa
status yuboradi (`request` → `confirmed`), xona holatini qayta
hisoblaydi.

**Davriy tozalash ishlaydi.** `pms-maintenance` navbati, har soat
boshida (`upsertJobScheduler`, BullMQ v6). To'lanmagan bron
`PENDING_PAYMENT_TIMEOUT_HOURS` dan oshsa `cancelReservation`
chaqiriladi — xona bo'shaydi, availability Beds24'ga ketadi,
OTA'da qayta sotuvga chiqadi.

**Xavfsizlik (§6) amalda:**

| Himoya | Holat |
|---|---|
| JWT talab qilinmaydi | mijoz ro'yxatdan o'tmagan — to'g'ri |
| Rate limiting | qidiruv 30/daqiqa, bron 5/soat |
| Honeypot `website` maydoni | to'ldirilgan bo'lsa 400, neytral xabar |
| Sana validatsiyasi | o'tmish yo'q, max 365 kecha, 1 yildan uzoq yo'q |
| Spam | bir raqamga 24 soatda 3 ta to'lanmagan bron |
| Ma'lumot sizishi | javobda ichki id, Beds24 id, sync holati, telefon yo'q |
| Kod topilmasa | 404, noto'g'ri shakl bilan bir xil javob |

**Tekshirilgan zanjir (TZ 3, 20-band):** `POST /api/public/reservations`
→ bron `IMR-LXWU4`, xona 106 avtomatik tanlandi → Shaxmatka API'sida
darhol ko'rindi (`source: website`, `pending_payment`) → deluxe
availability 2 dan 1 ga tushdi → mock Beds24 `status: request`,
`referer: PMS` oldi → `numAvail: 1` yuborildi.

---

## 8. Website frontend'iga o'zgartirish

> **Ish chegarasi.** Customer Website kodiga kirish huquqi **yo'q**.
> Shuning uchun bu faylda tavsiflangan API **to'liq yoziladi va test
> qilinadi**, lekin Website'ni unga ulash ishi **scope'dan tashqarida**.

Biz topshiradigan narsa:

| Tayyor bo'ladi | Kim ulaydi |
|---|---|
| `GET /api/public/availability` | Website dasturchisi |
| `POST /api/public/reservations` | |
| `GET /api/public/reservations/:code` | |
| Mock so'rovlar bilan test qilingan | |
| Bu hujjat — API kontrakti | |

API mock so'rovlar bilan uchdan-uchgacha test qilinadi: bo'sh xona
qidirish → bron yaratish → Shaxmatkada ko'rinish → Beds24'ga yuborish.
Ya'ni Website ulanganda **darhol ishlaydi**, qo'shimcha ish talab
qilmaydi.

Website dasturchisi uchun kerak bo'ladigan hamma narsa shu faylda:
endpoint'lar, so'rov/javob shakli, xato kodlari, rate limit
chegaralari, bron kodi formati.

---

## 9. Real-time

TZ 15-bandi real-time'ni faqat Shaxmatka uchun talab qiladi. Website
uchun WebSocket **kerak emas** — mehmon sahifani ochganda REST orqali
joriy holatni oladi.

Lekin teskari yo'nalish ishlaydi: Website'dan kelgan bron
**Shaxmatkada darhol** paydo bo'ladi (§4, c-nuqta) — bu TZ 3 va
20-bandning to'g'ridan-to'g'ri talabi.
