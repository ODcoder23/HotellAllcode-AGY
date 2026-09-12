# 02 — Database sxemasi (Prisma)

> **Manba:** `TZ-ASL.md` 13-band (jadvallar ro'yxati), 1-band (Beds24'dan
> keladigan maydonlar), 9-band (duplicate himoyasi), 14-band (to'lov).
> Mijoz qarorlari: **Q2** (har xonaning o'z ID raqami bor).

TZ 13-band talab qilgan **12 ta jadval** (`Channel`, `ChannelConnection`,
`ChannelMapping`, `WebhookEvent`, `SyncLog`, `Reservation`, `Room`,
`RoomType`, `Guest`, `Payment`, `RatePlan`, `Availability`) —
hammasi quyida. Ular ustiga TZ'ning boshqa bandlari talab qilgan
qo'shimcha jadvallar qo'shilgan (18-band `audit log` → `AuditLog`,
10-band `polling fallback` → `SyncState`, 7-band `source-of-truth
konfiguratsiyada` → `Settings`).

---

## 0. Ikki tamoyil — sxemani tushunish uchun

**1) `Room.id` — xona raqamining o'zi (mijoz qarori Q2).**
`cuid()` emas, balki `"101"`, `"202"`. Sabab: Shaxmatka frontendi
allaqachon `room.id === "101"` shaklida ishlaydi (`buildRooms()`
funksiyasi `id: number` qaytaradi), va mijoz "har bir xonaning o'zining
ID raqami bo'ladi" deb tasdiqladi. Bu ID **inson o'qiy oladigan,
barqaror** identifikator — Shaxmatka, API, SyncLog va Beds24 mapping'da
bir xil ishlatiladi.

**2) Availability ikki darajada yuritiladi.**
TZ 5-band xona darajasidagi mapping'ni (`Deluxe → Room 202`), 6-band
esa availability'ning kamayib-oshishini talab qiladi. Beds24 esa
availability'ni **room type bo'yicha son** shaklida qabul qiladi.
Shuning uchun:

```
PMS ichida:   har xona, har kun uchun aniq band/bo'sh holat  (RoomDayStatus)
Beds24'ga:    room type bo'yicha bo'sh xonalar SONI           (agregatsiya)
```

Bu ikkisi bir-biriga zid emas — ikkinchisi birinchisidan **hisoblab
chiqariladi**. Tafsilot: `07-AVAILABILITY-VA-RATES-SYNC.md` §2.

---

## 1. Prisma schema

```prisma
// ===================== KANAL / CHANNEL MANAGER (TZ 12, 13-band) =====================

model Channel {
  id          String   @id @default(cuid())
  code        String   @unique   // "beds24", "bronevik", "mybooking", ...
  name        String
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())

  connections ChannelConnection[]
  mappings    ChannelMapping[]
  webhooks    WebhookEvent[]
  syncLogs    SyncLog[]
  reservations Reservation[]
  syncStates  SyncState[]
}

// Har bir Channel uchun credentials — TZ 13, 18-band: frontendga chiqmaydi
model ChannelConnection {
  id                   String   @id @default(cuid())
  channelId            String
  channel              Channel  @relation(fields: [channelId], references: [id])
  refreshToken         String   // AES-256 bilan shifrlangan holda saqlanadi
  accessToken          String?  // qisqa umrli cache, shifrlangan
  accessTokenExpiresAt DateTime?
  propertyId           String   // Beds24 property id
  isActive             Boolean  @default(true)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@unique([channelId, propertyId])
}

// TZ 5-band: "Har bir mapping database'da saqlansin"
// Ikki darajali: RoomType ↔ Beds24 roomId, va Room ↔ Beds24 unit
model ChannelMapping {
  id                 String   @id @default(cuid())
  channelId          String
  channel            Channel  @relation(fields: [channelId], references: [id])

  // PMS tomoni — ikkisidan kamida bittasi to'ldiriladi
  roomTypeId         String?
  roomType           RoomType? @relation(fields: [roomTypeId], references: [id])
  roomId             String?
  room               Room?    @relation(fields: [roomId], references: [id])

  // Tashqi kanal tomoni
  externalRoomTypeId String   // Beds24 "roomId" — ularning atamasida room type
  externalUnitId     String?  // Beds24 unit id — jismoniy xona darajasi (TZ 5-band "Room 202")

  isActive           Boolean  @default(true)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  // Bitta tashqi room type + unit juftligi faqat bitta PMS obyektiga bog'lanadi
  @@unique([channelId, externalRoomTypeId, externalUnitId])
  // Bitta PMS xonasi bitta kanalda faqat bir marta mapping qilinadi
  @@unique([channelId, roomId])
  @@index([channelId, roomTypeId])
}

// TZ 10-band: "eventni saqlash", "duplicate tekshirish"
model WebhookEvent {
  id            String   @id @default(cuid())
  channelId     String
  channel       Channel  @relation(fields: [channelId], references: [id])
  eventType     String   // "reservation.created", "payment.updated", ...
  externalId    String?  // Beds24 bookingId — duplicate kaliti
  payloadHash   String   // rawPayload'ning SHA-256 hash'i — mazmun o'zgarganini aniqlash uchun
  rawPayload    Json     // sanitizatsiyadan o'tgan (10-fayl)
  status        WebhookStatus @default(RECEIVED)
  attempts      Int      @default(0)
  processedAt   DateTime?
  errorMessage  String?
  createdAt     DateTime @default(now())

  // TZ 9-band duplicate himoyasi — 1-qatlam.
  // DIQQAT: bu yerda createdAt BO'LMASLIGI shart. createdAt = now() har safar
  // boshqacha bo'lgani uchun, u constraint ichida bo'lsa dedup umuman ishlamaydi.
  @@unique([channelId, eventType, externalId, payloadHash])
  @@index([channelId, externalId])
  @@index([status, createdAt])
}

enum WebhookStatus {
  RECEIVED
  QUEUED
  PROCESSED
  FAILED
  IGNORED_DUPLICATE
  NEEDS_MANUAL_ACTION   // mapping topilmadi — 06-fayl §4
}

// TZ 16-band: channel, action, request, response, status, error, timestamp, reservation ID
model SyncLog {
  id            String   @id @default(cuid())
  channelId     String
  channel       Channel  @relation(fields: [channelId], references: [id])
  action        String   // "push_availability" | "push_rates" | "push_reservation" | "pull_bookings" | ...
  direction     SyncDirection
  reservationId String?
  roomId        String?
  request       Json?    // sanitizeForLog() dan o'tgan
  response      Json?    // sanitizeForLog() dan o'tgan
  status        SyncStatus
  attempt       Int      @default(1)
  errorMessage  String?
  durationMs    Int?
  createdAt     DateTime @default(now())   // = TZ'dagi "timestamp"

  @@index([channelId, status, createdAt])
  @@index([reservationId])
}

enum SyncDirection {
  PMS_TO_CHANNEL
  CHANNEL_TO_PMS
}

enum SyncStatus {
  SUCCESS
  FAILED
  RETRYING
  SKIPPED    // masalan: source-of-truth boshqa tomonda (TZ 7-band)
}

// TZ 10-band: polling/sync fallback uchun "oxirgi muvaffaqiyatli sync" nuqtasi
model SyncState {
  id                String   @id @default(cuid())
  channelId         String
  channel           Channel  @relation(fields: [channelId], references: [id])
  key               String   // "bookings_pull" | "rates_pull"
  lastSuccessfulAt  DateTime?
  lastCursor        String?
  updatedAt         DateTime @updatedAt

  @@unique([channelId, key])
}

// TZ 18-band: "audit log"
model AuditLog {
  id         String   @id @default(cuid())
  userId     String?
  user       User?    @relation(fields: [userId], references: [id])
  action     String   // "mapping.updated" | "settings.changed" | "webhook.reprocessed" | ...
  entityType String?
  entityId   String?
  before     Json?
  after      Json?
  ipAddress  String?
  createdAt  DateTime @default(now())

  @@index([userId, createdAt])
  @@index([entityType, entityId])
}

// TZ 7-band: "Qaysi tizim source-of-truth ekani konfiguratsiyada aniq belgilanadi"
model Settings {
  key        String   @id   // "SOURCE_OF_TRUTH_RATES" | "SOURCE_OF_TRUTH_AVAILABILITY" | ...
  value      String
  updatedAt  DateTime @updatedAt
  updatedBy  String?
}

// ===================== FOYDALANUVCHI / RBAC (TZ 18-band) =====================

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  fullName     String
  role         UserRole @default(STAFF)
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())

  auditLogs    AuditLog[]
}

enum UserRole {
  ADMIN     // to'liq huquq: Beds24 ulanishi, mapping, sozlamalar
  MANAGER   // bron, narx, hisobot — Beds24 sozlamalariga kirolmaydi
  STAFF     // check-in/check-out, to'lov qabul qilish
}

// ===================== MEHMONXONA ASOSIY MODELLARI (TZ 13-band) =====================

model RoomType {
  id          String   @id            // "standard" | "double" | "deluxe" — Shaxmatka bilan bir xil kalit
  label       String                  // "Standart" | "Ikki kishilik" | "Lyuks"
  multiplier  Float    @default(1)    // Shaxmatkadagi ROOM_TYPES.multiplier bilan bir xil
  sortOrder   Int      @default(0)

  rooms       Room[]
  mappings    ChannelMapping[]
  ratePlans   RatePlan[]
}

// Q2: Room.id — xona raqamining o'zi ("101"), cuid() EMAS.
// Shaxmatka frontendi aynan shu shaklda ishlaydi, o'zgartirilmaydi.
model Room {
  id          String     @id          // "101", "102", "202" — xona raqami = ID
  number      String     @unique      // id bilan bir xil qiymat, o'qishga qulaylik uchun
  floor       Int
  roomTypeId  String
  roomType    RoomType   @relation(fields: [roomTypeId], references: [id])
  status      RoomStatus @default(AVAILABLE)   // joriy jismoniy holat (sanaga bog'liq emas)
  isActive    Boolean    @default(true)        // false = inventarda umuman hisoblanmaydi
  sortOrder   Int        @default(0)

  mappings     ChannelMapping[]
  reservations Reservation[]
  dayStatuses  RoomDayStatus[]
}

// Shaxmatkadagi ROOM_STATUS bilan aynan bir xil qiymatlar
enum RoomStatus {
  AVAILABLE
  RESERVED
  OCCUPIED
  DIRTY
  OUT_OF_ORDER
  OUT_OF_SERVICE
}

// TZ 1-band: "mehmon ma'lumotlari"
model Guest {
  id          String   @id @default(cuid())
  fullName    String
  phone       String?
  email       String?
  country     String?   // Beds24 yuborsa saqlanadi
  address     String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  reservations Reservation[]

  @@index([phone])
  @@index([email])
}

model Reservation {
  id                    String   @id @default(cuid())
  roomId                String
  room                  Room     @relation(fields: [roomId], references: [id])
  guestId               String
  guest                 Guest    @relation(fields: [guestId], references: [id])

  // TZ 1-band maydonlari
  checkIn               DateTime @db.Date
  checkOut              DateTime @db.Date
  adults                Int      @default(1)
  children              Int      @default(0)
  pricePerNight         Decimal  @db.Decimal(12, 2)
  currency              String   @default("USD")
  source                ReservationSource
  notes                 String?
  withMeal              Boolean  @default(false)   // Shaxmatkada mavjud maydon

  // TZ 9-band: duplicate himoyasi
  channelId             String?          // null = direct/ichki bron
  channel               Channel? @relation(fields: [channelId], references: [id])
  externalReservationId String?          // Beds24 bookingId

  // TZ 8-band
  status                ReservationStatus @default(CONFIRMED)

  // TZ 1-band: "check-in", "check-out" — vaqt sifatida ham saqlanadi
  checkedInAt           DateTime?
  checkedOutAt          DateTime?
  cancelledAt           DateTime?

  // Sync holati (TZ 17-band: xato bo'lsa ham PMS ishlayveradi)
  syncStatus            EntitySyncStatus @default(PENDING)
  lastSyncedAt          DateTime?

  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  charges               Charge[]
  payments              Payment[]

  // TZ 9-band: "Unique constraint bo'lsin ... duplicate reservation yaratilmasin"
  @@unique([channelId, externalReservationId])
  @@index([roomId, checkIn, checkOut])
  @@index([status])
  @@index([syncStatus])
}

// Shaxmatkadagi SOURCES bilan aynan bir xil qiymatlar
enum ReservationSource {
  DIRECT
  WEBSITE
  BOOKING_COM
  AIRBNB
  EXPEDIA
  PHONE
  WALK_IN
  OTHER
}

// TZ 8-band: oltitasi ham to'liq qo'llab-quvvatlanadi (mijoz qarori Q5)
enum ReservationStatus {
  PENDING_PAYMENT
  CONFIRMED
  CHECKED_IN
  CHECKED_OUT
  CANCELLED
  NO_SHOW
}

enum EntitySyncStatus {
  PENDING     // navbatga qo'yilgan, hali yuborilmagan
  SYNCED      // Beds24 qabul qildi
  FAILED      // 5 urinishdan keyin ham bo'lmadi — Admin ko'radi
  NOT_APPLICABLE  // mapping yo'q yoki kanal o'chirilgan
}

model Charge {
  id            String   @id @default(cuid())
  reservationId String
  reservation   Reservation @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  label         String
  amount        Decimal  @db.Decimal(12, 2)
  createdAt     DateTime @default(now())

  @@index([reservationId])
}

// TZ 14-band
model Payment {
  id                String   @id @default(cuid())
  reservationId     String
  reservation       Reservation @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  amount            Decimal  @db.Decimal(12, 2)   // manfiy = reversal
  method            String                        // "Naqd" | "Karta" | "Bank o'tkazmasi" | "Onlayn"
  paymentDate       DateTime @db.Date             // Shaxmatkadagi payment.date
  note              String?
  externalPaymentId String?                       // Beds24'dan kelgan bo'lsa
  channelId         String?                       // qaysi kanal orqali to'langan
  createdAt         DateTime @default(now())

  @@unique([channelId, externalPaymentId])  // bir to'lov ikki marta yozilmasin
  @@index([reservationId])
}

// TZ 7-band
model RatePlan {
  id          String   @id @default(cuid())
  roomTypeId  String
  roomType    RoomType @relation(fields: [roomTypeId], references: [id])
  date        DateTime @db.Date
  price       Decimal  @db.Decimal(12, 2)
  minStay     Int      @default(1)
  source      String   @default("pms")   // "pms" | "beds24" — oxirgi yangilanish qayerdan kelgan
  updatedAt   DateTime @updatedAt

  @@unique([roomTypeId, date])
  @@index([date])
}

// ===================== AVAILABILITY (TZ 6, 13-band) =====================

// TZ 13-band aynan "Availability" jadvalini talab qiladi.
// Bu — room type darajasidagi, Beds24'ga YUBORILADIGAN holat (kesh/jurnal).
// Qiymat RoomDayStatus'dan hisoblab chiqariladi, qo'lda yozilmaydi.
model Availability {
  id            String   @id @default(cuid())
  roomTypeId    String
  date          DateTime @db.Date
  totalRooms    Int      // shu turdagi faol xonalar soni
  bookedRooms   Int      // band qilinganlari
  blockedRooms  Int      // OUT_OF_ORDER / OUT_OF_SERVICE
  availableCount Int     // = totalRooms - bookedRooms - blockedRooms
  syncedCount   Int?     // Beds24'ga oxirgi marta yuborilgan qiymat
  syncedAt      DateTime?
  updatedAt     DateTime @updatedAt

  @@unique([roomTypeId, date])
  @@index([date])
  @@index([syncedAt])
}

// Xona darajasidagi kunlik holat — PMS ichki haqiqat manbai.
// TZ 5-band "Deluxe → Room 202" talabi aynan shu darajada bajariladi.
model RoomDayStatus {
  id            String   @id @default(cuid())
  roomId        String
  room          Room     @relation(fields: [roomId], references: [id])
  date          DateTime @db.Date
  isBlocked     Boolean  @default(false)   // ta'mir/xizmatdan chiqarilgan
  blockReason   String?
  updatedAt     DateTime @updatedAt

  @@unique([roomId, date])
  @@index([date])
}
```

---

## 2. Raw SQL migratsiya — overbooking himoyasi (TZ 3-band)

**Bu qismni Prisma o'zi yarata olmaydi.** TZ 3-bandi
*"OVERBOOKING BO'LMASLIGI SHART"* deydi — buni faqat dastur mantig'iga
ishonib qo'yish yetarli emas, chunki ikki parallel so'rov bir vaqtda
tekshiruvdan o'tib ketishi mumkin (race condition). Shuning uchun
kafolat **database darajasida** qo'yiladi:

```sql
-- prisma/migrations/xxxx_overbooking_guard/migration.sql

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Bitta xonaga, sana oralig'i kesishadigan ikkita FAOL bron
-- jismonan yaratilmaydi. Bekor qilingan/no-show bronlar hisobga olinmaydi.
ALTER TABLE "Reservation"
  ADD CONSTRAINT reservation_no_overlap
  EXCLUDE USING gist (
    "roomId" WITH =,
    daterange("checkIn", "checkOut", '[)') WITH &&
  )
  WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'));
```

- `'[)'` — chegara qoidasi: `checkIn` kiradi, `checkOut` kirmaydi.
  Ya'ni bir mehmon 10-da chiqsa, boshqasi 10-da kirishi mumkin.
  Bu Shaxmatka frontendidagi `ci < rco && co > rci` mantig'i bilan
  **aynan bir xil**.
- Constraint ishga tushganda PostgreSQL `23P01` xato kodini qaytaradi —
  backend buni ushlab, foydalanuvchiga "Bu xona ushbu sanalar uchun
  band" deb ko'rsatadi (Shaxmatkadagi mavjud `conflictMsg` mexanizmi).

---

## 3. Shaxmatka frontendi bilan moslik jadvali

Frontend kodi (`index (7).html`) o'zgarmaydi — API javobi uning
kutayotgan shakliga moslanadi.

| Shaxmatka maydoni | DB manbai | API javobida |
|---|---|---|
| `room.id` | `Room.id` | `"101"` — bir xil (Q2) |
| `room.number/floor/status` | `Room.*` | to'g'ridan-to'g'ri |
| `room.type` | `Room.roomTypeId` | `"standard"` — kichik harf |
| `res.id` | `Reservation.id` | cuid |
| `res.roomId` | `Reservation.roomId` | `"101"` |
| `res.guestName` | `Guest.fullName` | **flatten** qilinadi |
| `res.phone` | `Guest.phone` | **flatten** qilinadi |
| `res.checkIn/checkOut` | `DateTime @db.Date` | `"YYYY-MM-DD"` string |
| `res.adults/children` | bir xil | number |
| `res.source` | `ReservationSource` | `BOOKING_COM` → `"booking_com"` |
| `res.status` | `ReservationStatus` | `PENDING_PAYMENT` → `"pending_payment"` (Q5) |
| `res.pricePerNight` | `Decimal` | **number** ga o'giriladi |
| `res.notes` / `res.withMeal` | bir xil | to'g'ridan-to'g'ri |
| `res.createdAt` | `DateTime` | epoch millisekund (number) |
| `res.charges[]` | `Charge[]` | `{id, label, amount:number}` |
| `res.payments[]` | `Payment[]` | `{id, amount:number, method, date:"YYYY-MM-DD", note}` |

**Decimal → number.** Prisma `Decimal` obyekt qaytaradi, frontend esa
sonni kutadi (`p.amount` ustida `reduce` qiladi). Konvertatsiya API
serializatsiya qatlamida, bitta markaziy joyda bajariladi — har
controllerda alohida emas.

**Yangi maydonlar** (`channelId`, `externalReservationId`, `syncStatus`,
`checkedInAt`) API javobida qo'shimcha kalit sifatida boradi. Frontend
ularni bilmaydi va e'tiborsiz qoldiradi — hech narsa buzilmaydi.

---

## 4. Seed ma'lumotlari

`buildRooms()` dagi 12 xona aynan shu ID'lar bilan seed qilinadi:

```
1-qavat: 101 standard, 102 standard, 103 double,
         104 double,   105 standard, 106 deluxe
2-qavat: 107 standard, 108 double,   109 standard,
         110 deluxe,   111 standard, 112 double
```

Natijada turlar bo'yicha: **standard 5 ta**, **double 4 ta**,
**deluxe 3 ta**. Bu sonlar `Availability.totalRooms` ning boshlang'ich
qiymati bo'ladi va agregatsiya mantig'ini tekshirishda ishlatiladi
(`07`-fayl §2).

`RoomType` seed: `standard` (×1.0), `double` (×1.2), `deluxe` (×1.5) —
Shaxmatkadagi `ROOM_TYPES` bilan aynan bir xil.
