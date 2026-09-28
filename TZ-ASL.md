# ASL TZ — IMRON HOTEL PMS × BEDS24 TO'LIQ INTEGRATSIYA

> **MIJOZNING ASL TOPSHIRIG'I — o'zgartirilmagan.**
>
> Bu hujjat biznes talabining manbasi. Tizim shu asosda
> qurilgan, lekin **amaldagi holat undan farq qiladi**:
> ish davomida yangi talablar qo'shilgan (FOUNDER roli,
> tozalik tizimi, oshxona, nonushta tarifi).
>
> **Hozir nima ishlayotgani:** [PROJECT_LOGIC.md](PROJECT_LOGIC.md).
> Channel Manager TZ'si (2026-09-18) — oxirida, ilova.
>
> Texnik yoyilma hujjatlari (`00`–`13`) 2026-09-18 da o'chirildi —
> ular kod bilan zid bo'lib qolgan edi. Muhim qoidalar
> `PROJECT_LOGIC.md` ga ko'chirilib, kod bilan tasdiqlangan.

---

**MUHIM:**
Admin Panel, Customer Website va mavjud Shaxmatka allaqachon yaratilgan.
Ularni qayta yasamang.
Faqat backend + database + Beds24 integratsiyasini mavjud frontendlarga moslab qiling.

**ASOSIY ARXITEKTURA:**

```
Booking.com
Airbnb
Expedia
      ↓
    Beds24
      ↕️ API / Webhook
   PMS Backend
      ↕️
 PostgreSQL Database
      ↕️
 Mavjud Shaxmatka
      ↕️
Admin Panel / Website
```

---

## 1. BEDS24DAN PMSGA MA'LUMOT KELISHI

Beds24 dan quyidagilar PMSga olinishi kerak:

- yangi bron
- bron o'zgarishi
- bron bekor qilinishi
- mehmon ma'lumotlari
- check-in
- check-out
- kattalar soni
- bolalar soni
- xona turi
- xona
- kelish sanasi
- ketish sanasi
- narx
- valyuta
- to'lov ma'lumotlari
- bron manbasi
- Beds24 booking ID

Kelgan ma'lumot PostgreSQL database'ga yoziladi.

Keyin mavjud Shaxmatkada avtomatik ko'rinadi.

---

## 2. SHAXMATKA → BEDS24

Shaxmatkada admin:

- yangi bron yaratsa
- bronni o'zgartirsa
- xonani almashtirsa
- sanani o'zgartirsa
- mehmon sonini o'zgartirsa
- narxni o'zgartirsa
- bronni bekor qilsa
- check-in/check-out qilsa

tegishli ma'lumot Beds24 bilan sinxronlashtiriladi.

---

## 3. WEBSITE → PMS → BEDS24

Saytdan mijoz xona bron qilsa:

```
Website
 ↓
PMS Backend
 ↓
Database
 ↓
Shaxmatka
 ↓
Beds24
 ↓
OTA kanallari
```

Bron qilingan xona boshqa kanallarda mavjud bo'lmagan holatga o'tishi kerak.

**OVERBOOKING BO'LMASLIGI SHART.**

---

## 4. OTA → BEDS24 → PMS

Masalan Booking.com'dan bron keldi:

```
Booking.com
 ↓
Beds24
 ↓
Webhook/API
 ↓
PMS Backend
 ↓
Database
 ↓
Shaxmatka
```

Shaxmatkada bron avtomatik paydo bo'ladi.

Admin sahifani refresh qilmasdan ham yangi bronni ko'rishi uchun WebSocket/real-time update ishlatilsin.

---

## 5. XONA MAPPING

Eng muhim qism.

PMSdagi:

```
RoomType
Room
```

Beds24dagi:

```
Room Type / Room
```

bilan mapping qilinadi.

Masalan:

```
PMS:
Deluxe → Room 202

Beds24:
Deluxe → tegishli Beds24 room/unit
```

Har bir mapping database'da saqlansin.

Noto'g'ri xona turiga bron tushmasligi kerak.

---

## 6. AVAILABILITY SYNC

PMSdagi xona band bo'lsa:

```
PMS
 ↓
Beds24
 ↓
Booking.com / Airbnb / Expedia
```

availability kamayadi.

Xona bo'shatilsa availability qayta oshadi.

Har bir o'zgarish queue orqali yuborilsin.

Temporary API xatosi PMS ishini to'xtatmasin.

---

## 7. RATES SYNC

PMSda xona narxi o'zgarsa:

```
PMS
 ↓
Beds24
 ↓
OTA
```

Narxlar sinxronlashtirilsin.

Agar Beds24dan narx o'zgarsa, PMSga ham update kelishi kerak.

Qaysi tizim source-of-truth ekani konfiguratsiyada aniq belgilanadi.

---

## 8. RESERVATION STATUS

Quyidagi statuslar qo'llab-quvvatlansin:

```
PENDING_PAYMENT
CONFIRMED
CHECKED_IN
CHECKED_OUT
CANCELLED
NO_SHOW
```

Beds24 statuslari PMS statuslariga mapping qilinsin.

---

## 9. DUPLICATE BRONLAR

Har bir external booking uchun:

```
channel
external_reservation_id
```

saqlansin.

Unique constraint bo'lsin.

Bir bron webhook/API orqali ikki marta kelib qolsa,
duplicate reservation yaratilmasin.

---

## 10. WEBHOOK

Beds24 webhook endpoint:

```
POST /api/webhooks/beds24
```

Webhook:

- validate
- eventni saqlash
- duplicate tekshirish
- queuega yuborish
- database update
- Shaxmatkani update qilish

Webhook ishlamasa polling/sync fallback mexanizmi bo'lsin.

---

## 11. SYNC QUEUE

Redis + BullMQ ishlatilsin.

Queue:

```
beds24-reservation-sync
beds24-availability-sync
beds24-rate-sync
beds24-webhook
beds24-retry
```

API xato bersa:

```
retry → retry → retry
```

bo'lsin.

Errorlar SyncLog'ga yozilsin.

---

## 12. CHANNEL MAPPING

Arxitektura faqat Beds24 bilan cheklanmasin.

Keyinchalik:

```
Booking.com
Airbnb
Expedia
Bronevik
MyBooking
```

kabi kanallarni qo'shish mumkin bo'ladigan qilib yozilsin.

Lekin API mavjud bo'lmagan platforma uchun
fake API, scraping yoki browser automation ishlatilmasin.

---

## 13. DATABASE

Kamida:

```
Channel
ChannelConnection
ChannelMapping
WebhookEvent
SyncLog
Reservation
Room
RoomType
Guest
Payment
RatePlan
Availability
```

jadvallari bo'lsin.

Beds24 API credentials frontendga chiqmasin.

---

## 14. TO'LOV

Beds24dan kelgan payment ma'lumotlari PMS reservation bilan bog'lansin.

PMSdagi:

```
totalPrice
paidAmount
remainingAmount
```

aniq hisoblanishi kerak.

Shaxmatkada:

```
To'liq to'langan
Qarz bor
```

holati ko'rinsin.

---

## 15. REAL-TIME SHAXMATKA

Beds24dan yangi bron kelganda:

```
Backend
 ↓
Database
 ↓
WebSocket
 ↓
Shaxmatka
```

Shaxmatka avtomatik yangilansin.

Events:

```
reservation.created
reservation.updated
reservation.cancelled
room.status.changed
availability.changed
payment.updated
```

---

## 16. SYNC LOG

Har bir sync:

- channel
- action
- request
- response
- status
- error
- timestamp
- reservation ID

bilan log qilinsin.

Secret/token/password log qilinmasin.

---

## 17. ERROR HOLATI

Beds24 vaqtincha ishlamasa:

PMS ishlashda davom etishi kerak.

Bron database'ga saqlansin.

Queue syncni kutib tursin.

Beds24 qayta ishlaganda avtomatik yuborilsin.

---

## 18. SECURITY

- API credentials faqat backendda
- .env / secure storage
- JWT authentication
- RBAC
- webhook validation
- rate limiting
- HTTPS
- audit log
- sensitive data log qilinmasin

---

## 19. ASOSIY QOIDA

PMSning ichki ishlashi Beds24ga bog'lanib qolmasin.

PMS + Database mustaqil ishlaydi.

Beds24 esa Channel Manager sifatida ikki tomonlama integratsiya qilinadi.

---

## 20. YAKUNIY NATIJA

Mijoz Website'dan bron qilsa:
→ Shaxmatkada ko'rinsin
→ xona band bo'lsin
→ Beds24ga yuborilsin
→ OTA availability yangilansin.

Booking.com/Airbnb/Expedia'dan bron kelsa:
→ Beds24 qabul qiladi
→ PMSga yuboradi
→ Database'ga yoziladi
→ Shaxmatkada avtomatik ko'rinadi
→ xona band bo'ladi.

Admin Shaxmatkada o'zgartirish qilsa:
→ Database yangilanadi
→ Beds24 yangilanadi
→ OTA kanallari yangilanadi.

**YA'NI BARCHA TIZIMLAR BIR XIL INVENTORY ASOSIDA ISHLASHI KERAK.**

---

# MIJOZ TOMONIDAN TASDIQLANGAN QARORLAR

TZ'dagi ochiq nuqtalar bo'yicha mijozdan olingan aniq javoblar.
Bular TZ bilan bir xil kuchga ega va texnik hujjatlarda shu tarzda
amalga oshirilgan.

| № | Savol | Mijoz javobi |
|---|---|---|
| Q1 | Xonalar Shaxmatkada qanday ko'rinadi | **Har xona alohida qator** bo'lib ko'rinadi. Beds24 o'z tomonida o'z tizimi bilan yuritadi — biz unga ma'lumot yuboramiz. |
| Q2 | Xona identifikatori | **Har xonaning o'z ID raqami bor** (`"101"`, `"202"`). `Room.id` = xona raqami. |
| Q3 | Beds24'dan kelgan bron qaysi xonaga tushadi | **Avtomatik** — PMS o'zi bo'sh xonani tanlaydi, admin aralashuvi kerak emas. Beds24 bronni allaqachon qabul qilgan, u Shaxmatkada darhol ko'rinishi shart. |
| Q5 | `PENDING_PAYMENT` va `NO_SHOW` statuslari | **Shaxmatkaga qo'shiladi** (Variant B). TZ 8-bandi 6 ta statusni talab qiladi — hammasi to'liq qo'llab-quvvatlanadi. |
| Q6 | Xona almashtirilsa | **Beds24'da ham ko'rinishi kerak** — sync majburiy. |
| Q7 | Check-in / check-out Beds24'ga | **Qo'llab-quvvatlanadi, muammo yo'q** — sync qilinadi. |
| Q8 | Dinamik (avtomatik o'suvchi) narxlash | **Mexanizm olib tashlanadi** (`base + confirmedCount × increment`) — TZ'da bunday talab yo'q va formula xato (jami bronlar soniga qaraydi, sanadagi bandlikka emas). **Narxlar paneli UI sifatida qoladi**, endi `RatePlan` qiymatlarini ko'rsatadi va tahrirlashga imkon beradi. |
| Q9 | Beds24 va PMS farq qilsa kim to'g'ri (2026-09-25) | **"Beds24 tanlovi doim ustuvor."** Beds24 markaziy tizim, Shaxmatka — uni boshqarish oynasi. TZ 7-band "source of truth" = `beds24` (narx va mavjudlik). OTA bronining sanasi, narxi va bekor qilinishi OTA'da. Batafsil: [BEDS24.md](BEDS24.md) 2-bo'lim |
| Q10 | Beds24 obyekt valyutasi (2026-09-25) | **USD — to'g'ri.** PMS moslashdi (Q13) |
| Q11 | Qaysi OTA'lar (2026-09-25) | **Booking.com va ETG/Ostrovok** Beds24 orqali. Bron sayt va admin tomonidan ham qo'yiladi. Narxni admin o'zgartiradi |
| Q12 | Real Beds24'ga ulash (2026-09-25) | Egasi kalit berdi, lekin **ruxsatsiz ulanmaydi**: avval faqat o'qib o'rganish va moslashtirish. Beds24'dagi 2 xona — sinov uchun, obyekt ma'lumotini egasi to'ldiradi. Beds24 paneli sozlamalari (xona turlari, unitlar, webhook) — keyin Beds24 tomonida |
| Q13 | Valyuta va eski ma'lumot (2026-09-25) | ~~**Butun tizim USD**~~ — **Q15 bilan bekor qilindi.** Asl matn: **Butun tizim USD** — Shaxmatka, sayt, hisobot, botlar ("hammasi tizimimizda USD da bo'lsin"). Sxema migratsiyasiga ruxsat. Bazadagi bronlar — **test ma'lumoti, tozalanadi** (backupdan keyin). Deploy'ni egasi o'zi qiladi — hammasi tayyorlab qo'yiladi ([SERVER.md](SERVER.md) "USD ga o'tish") |
| Q14 | Nonushta narxi (2026-09-25) | Admin panelda (Oshxona) o'zgartiriladi; o'zgarsa **butun tizim hisobi** yangilanadi, "qolib ketmasligi kerak". Barcha hisob-kitoblar mukammal bo'lsin → yagona formula `backend/src/lib/money.ts`, faol bronlarga qo'llash tanlovi |
| Q15 | Valyuta — yakuniy (2026-09-25 kechqurun) | "Faqat Beds24'dan kelgan bronlar dollarda va tagida so'm bilan ko'rinsin, qolgan hammasi so'mda; dollar chet ellik mehmonlar uchun." Tizim **so'mda** (sayt, Shaxmatka, hisobot, bot, maosh, xarajat, nonushta). Beds24 broni o'z valyutasida (USD), tagida so'm — **bron kelgan kundagi** Markaziy bank kursi (bronga yoziladi). Kurs **Markaziy bankdan avtomatik**, admin qo'lda o'zgartira oladi. Dollar bronda mehmon so'mda to'lasa — **xodim valyutani tanlaydi**, ~~bugungi kurs bilan~~ **bron kursi bilan (Q19)**, asl summa saqlanadi. Narx Beds24'ga **kurs bo'yicha aylantirib** yuboriladi (so'm / kurs = $). Hisobot so'mda. Deploy'ni shu kuni egasining so'rovi bilan biz qildik ([SERVER.md](SERVER.md)) |
| Q16 | Bekor qilish jarimasi (2026-09-26) | **Jarima yo'q** — bron har qanday vaqtda bepul bekor qilinadi (ilgari kirishga 24 soatdan kam qolsa 1 kecha). `CANCEL_FEE_NIGHTS` standarti 0; mexanizm sozlamada qoldi |
| Q18 | Beds24 integratsiyasi (2026-09-26) | ~~**Olib tashlanadi.**~~ — **Q19 bilan bekor qilindi.** Asl matn: **Olib tashlanadi.** Avval Beds24 bilan ma'lumot almashinuvi to'liq tahlil qilinadi, keyin kod, endpoint, navbat, davriy vazifa va sozlamalar o'chiriladi; Beds24'dan kelgan test tarixi tizimda qolmasin, asosiy biznes logikasi buzilmasin. **Q9, Q10, Q12, Q15 dagi Beds24 va dollar qismlari bekor** — tizim faqat so'mda, PMS yagona haqiqat manbai. OTA bronlari qo'lda kiritiladi. Bajarildi va serverga chiqarildi ([BEDS24.md](BEDS24.md)) |
| Q17 | Tizim nazorati — STOP (2026-09-26) | ~~**STOP**~~ — **Q19 bilan butunlay olib tashlandi.** Asl matn: Shaxmatka → Sozlamalar → "Tizim nazorati": STOP → "Barcha xonalar" (yoki ayrim xonalar) → "Vaqtincha to'xtatishni tasdiqlash". Sayt va qabulxona yangi bron qabul qilmaydi (Booking.com Beds24 orqali ham yopilardi — Q18 dan keyin OTA o'z kabinetida yopiladi) — "band"; Shaxmatka xiralashadi. Mavjud bronlar saqlanadi (kirish, chiqish, to'lov ishlaydi). Faqat "Stopdan chiqarish" qayta ochadi; ta'mir kabi boshqa yopiqlarga tegilmaydi. Egasiga Telegram xabari. `services/salesStop.ts` |
| Q19 | Beds24 qaytadi, STOP olib tashlanadi (2026-09-27) | **Beds24 integratsiyasi avvalgidek qaytadi** — ikki tomonlama: Beds24 bronlari PMS'ga tushadi, PMS bronlari, narxlari va yopiq kunlari Beds24'ga yuboriladi. **Q18 bekor; Q9, Q10, Q12, Q15 yana kuchda.** Egasi invite code beradi, ulash admin paneldan (Channel manager: egasi va admin boshqaradi, menejer ko'radi). Dollar Beds24 broni **Shaxmatkada hamma xodimga** ikki xil ko'rinadi: asl $ va bron kelgan kundagi kurs bilan so'm; to'lov so'mda qabul qilinadi — **bron kursi** bilan dollarga o'giriladi, asl so'm saqlanadi. Sayt broni qoidalari o'zgarmaydi: har doim nonushta bilan, "to'lov kutilmoqda", ~~24 soatda to'lanmasa avtomatik bekor~~ (Q20: o'chirildi). **STOP (Q17) butunlay olib tashlanadi**, sotuvni to'xtatish — Beds24 panelida. Vaqt hamma joyda Toshkent bo'yicha. Batafsil: [BEDS24.md](BEDS24.md) |
| Q20 | Sayt to'lovi va nonushta kuni (2026-09-28) | **Sayt mehmoni to'lovni kelganda qiladi** (sayt ham shuni aytadi). Oldindan to'lov — Beds24 (OTA) mehmonlari, uni OTA boshqaradi. To'lanmagan sayt bronini 24 soatda avtomatik bekor qilish **o'chirildi**: muddat biznes sozlamasi (admin panel → Sozlamalar, standart 0 — o'chiq). Spam himoyasi: bir telefon raqamiga 3 ta faol to'lanmagan sayt broni. **Nonushta tunashdan keyingi ertalab** — kelgan kuni yo'q, ketadigan kuni bor (oshxona hisobi; bron summasi o'zgarmaydi: nonushta soni = kecha soni). |

**Q7 amalda (2026-09-25):** Beds24 API'sida check-in/out uchun
status ham, subStatus ham yo'q. Sinxronizatsiya bron bayrog'i
(`flagText` "Checked-in" / "Checked-out") orqali qilinadi — Beds24
kalendarida ko'rinadi.

**Qolgan barcha savollarga javob TZ'ning o'zidan olinadi** — mijoz
ko'rsatmasi: *"qolgan savolarga javobni shu TZ dan topasan"*. Ya'ni
TZ'da yozilgan narsa aynan yozilganidek bajariladi, TZ'da yo'q narsa
qo'shilmaydi va TZ talabi kuchsizlantirilmaydi.

---

# ILOVA: CHANNEL MANAGER API INTEGRATSIYASI TZ (2026-09-18)

Buyurtmachi TZ'si, 2026-09-18. Bajarilishi — [BEDS24.md](BEDS24.md), "TZ ↔ kod". Matn o'zgartirilmagan — faqat markdown
formatiga keltirilgan (vertikal strelkali oqimlar bir qatorga yozilgan).

```
Booking.com
     ↕
 Expedia
     ↕
  Boshqa OTA
     ↕
┌───────────────┐
│ Beds24 /      │
│ Channel API   │
└───────┬───────┘
        ↕
┌────────────────────┐
│ BIZNING BACKEND    │
│ Channel Manager    │
└─────────┬──────────┘
          ↕
    Bizning PMS
          ↕
     Admin Panel
```

### TEXNIK TOPSHIRIQ — Channel Manager API integratsiyasi

#### 1. Maqsad

Biz o’zimizning Hotel PMS/Admin Panel tizimimizni tayyor Channel Manager
platformasi API’si orqali OTA kanallarga ulaymiz.

Masalan:
- Beds24
- yoki shunga o’xshash Channel Manager

Biz Booking.com, Expedia va boshqa OTA’larni alohida API orqali
to’g’ridan-to’g’ri integratsiya qilmaymiz.

Asosiy ma’lumot almashinuvi Channel Manager API orqali amalga oshiriladi.

#### 2. Asosiy prinsip

Bizning tizim Channel Manager API bilan:

**MA’LUMOT QABUL QILADI** — Channel Manager → Bizning Backend. Masalan:
- yangi booking
- booking o’zgarishi
- booking cancellation
- guest ma’lumotlari
- check-in
- check-out
- room
- price
- availability
- channel
- booking status

**MA’LUMOT YUBORADI** — Bizning Backend → Channel Manager. Masalan:
- room availability
- room price
- booking status
- restrictions
- room mapping
- reservation updates

#### 3. Ma’lumot qabul qilish

Channel Manager’dan keladigan ma’lumotlar bizning backendda qabul qilinadi.

Misol:

```json
{
  "booking_id": "123456",
  "channel": "booking",
  "guest": {
    "first_name": "Ali",
    "last_name": "Aliyev",
    "phone": "+998901234567"
  },
  "room": "Standard Double",
  "check_in": "2026-09-20",
  "check_out": "2026-09-22",
  "guests": 2,
  "price": 120,
  "currency": "USD",
  "status": "confirmed"
}
```

Backend ushbu ma’lumotni qabul qilib database’ga yozadi.

#### 4. Webhook

Agar Channel Manager webhook qo’llab-quvvatlasa, webhook ishlatiladi.

Masalan: `POST /api/channel/webhook`

Channel Manager yangi booking olganda:
Channel Manager → POST webhook → Bizning Backend → Database → Admin Panel

Admin panelda booking real-time yoki imkon qadar tez ko’rinishi kerak.

#### 5. Booking qabul qilish

Masalan, Booking.com orqali mehmon xona bron qildi.

Jarayon: Guest → Booking.com → Channel Manager → Webhook / API → Bizning
Backend → Database → Admin Panel

Admin panelda **New Reservation** paydo bo’ladi.

#### 6. Booking cancellation

Mehmon bookingni bekor qilsa:
Booking.com → Channel Manager → Webhook → Bizning Backend → Reservation
status = CANCELLED

Database’dagi booking avtomatik cancelled bo’lishi kerak.

#### 7. Booking modification

Mehmon:
- check-in sanasini
- check-out sanasini
- guest sonini
- roomni
- boshqa booking ma’lumotlarini

o’zgartirsa, Channel Manager’dan kelgan yangi ma’lumot bizning booking
bilan update qilinadi.

`external_booking_id` orqali mavjud booking topiladi.

Yangi duplicate booking yaratilmasligi kerak.

#### 8. Bizning tizimdan Channel Manager’ga ma’lumot yuborish

Admin yoki PMS’da availability o’zgarsa:
Admin Panel → Our Backend → Channel Manager API → OTA Channels

Masalan:
- Oldin: Standard Double, Availability = 5
- 1 ta booking bo’ldi.
- Bizning PMS: Availability = 4
- Backend Channel Manager API orqali Availability = 4 yuboradi.

Channel Manager esa ulangan OTA’larga tarqatadi.

#### 9. Price synchronization

Bizning PMS’da: Standard Double, 20 September, Price = $60 bo’lsa, API
orqali Channel Manager’ga yuboriladi.

Our PMS → Channel Manager API → Booking.com / Expedia / Other OTA

#### 10. Availability synchronization

Quyidagi ma’lumotlarni Channel Manager API orqali yuborish kerak:
- Room availability
- Price
- Minimum stay
- Maximum stay
- Closed/Open
- Closed for arrival
- Closed for departure

Channel Manager imkoniyatiga qarab qo’llab-quvvatlanadigan parametrlar
implement qilinadi.

#### 11. Room Mapping

Bizning PMS’dagi roomlar Channel Manager’dagi roomlar bilan mapping
qilinadi.

```
OUR PMS                  CHANNEL MANAGER

Room 101 ─────────────→ Standard Double
Room 102 ─────────────→ Standard Double
Room 201 ─────────────→ Deluxe
```

Mapping database’da saqlanadi. Masalan:
- channel_id
- external_property_id
- external_room_id
- internal_room_id

#### 12. Channel Manager account

Admin panelda Channel Manager account ulash bo’limi bo’ladi.

Masalan: Settings → Channel Manager

Fields:
- Provider
- API Key
- API Secret / Token
- Property ID
- [Connect]

Ulanishdan keyin **Connected ✓** ko’rsatiladi.

API credentiallar xavfsiz saqlanishi kerak.

#### 13. Multiple Channel Manager Provider

Arxitektura faqat Beds24’ga bog’lanib qolmasligi kerak.

```
ChannelManagerProvider
        │
        ├── Beds24
        ├── Provider 2
        └── Provider 3
```

Keyinchalik boshqa Channel Manager API qo’shish oson bo’lishi kerak.

#### 14. API Service Architecture

Backendda alohida service bo’lishi kerak:

```
ChannelManagerService
│
├── connect()
├── getProperties()
├── getRooms()
├── getBookings()
├── getBooking()
├── updateAvailability()
├── updatePrices()
├── updateRestrictions()
├── updateBooking()
└── cancelBooking()
```

Aniq endpoint va parametrlar tanlangan Channel Manager API documentation
asosida implement qilinadi.

#### 15. Sync mexanizmi

Tizim ikki xil usuldan foydalanishi mumkin:

**Webhook** — Channel Manager ma’lumot o’zgarganda bizning backendga
yuboradi.

**Polling** — agar webhook mavjud bo’lmasa, backend ma’lum intervalda API
orqali ma’lumotni tekshiradi. Masalan:
Every 1–5 minutes → GET bookings → Compare/update database

Webhook mavjud bo’lsa, asosiy mexanizm sifatida webhook ishlatiladi.

#### 16. Sync Log

Har bir API operation log qilinadi:

```
Provider: Beds24
Action: UPDATE_AVAILABILITY
Room: Standard Double
Date: 20.09.2026
Value: 4
Status: SUCCESS
Time: 19:30:21
```

Xatolik:

```
Status: FAILED
Error: API authentication failed
```

Admin panelda error ko’rinishi kerak.

#### 17. Duplicate protection

Bir booking webhook orqali bir necha marta kelsa, duplicate booking
yaratilmasligi kerak.

Buning uchun `provider + external_booking_id` unique bo’lishi kerak.

Masalan: `beds24 + 123456` bir marta mavjud bo’lsa, keyingi request
bookingni yaratmaydi, balki update qiladi.

#### 18. Data flow

- Booking qabul qilish: OTA → Channel Manager → Webhook/API → Our Backend →
  Database → PMS → Admin Panel
- Availability yuborish: Admin/PMS → Our Backend → Channel Manager API → OTA
- Price yuborish: PMS → Backend → Channel Manager API → Booking / Expedia /
  Other OTA

#### 19. Muhim talab

Channel Manager bizning tizimimiz uchun “bridge” vazifasini bajaradi.

Bizning tizim:
- ma’lumotni qabul qiladi;
- database’ga saqlaydi;
- PMS/Admin Panel’da ko’rsatadi;
- kerakli o’zgarishlarni Channel Manager API’ga yuboradi.

Channel Manager esa OTA kanallar bilan ishlaydi.

Shuning uchun backend Channel Manager API’ning **READ + WRITE**
funksiyalarini qo’llab-quvvatlashi kerak.

Ya’ni faqat bookinglarni olib kelish emas, balki bizning tizimdan Channel
Manager’ga ma’lumot yuborish ham majburiy.
