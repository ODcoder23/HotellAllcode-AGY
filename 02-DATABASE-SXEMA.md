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


**Bu fayl javob beradi:**

- Qaysi jadvallar bor va nima uchun?
- `Room.id` nima — cuid yoki xona raqami?
- Overbooking DB darajasida qanday to'xtatiladi?
- API javobi Shaxmatka kutgan shaklga qanday moslanadi?

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
chiqariladi**. Tafsilot: `[07](07-AVAILABILITY-VA-RATES-SYNC.md)` §2.

---

## 1. Modellar — to'liq ro'yxat

> **To'liq schema kodda:** [backend/prisma/schema.prisma](backend/prisma/schema.prisma)
>
> Yagona nusxa — Prisma o'sha fayldan migratsiya va klient yasaydi.
> Ilgari ildizda ko'chirma nusxa turardi va u eskirib qolgan edi
> (Settings, SYNCING, maxAdults yo'q edi); topshirishdan oldin
> o'chirildi.
> (18 model, 8 enum, 421 qator). U yerdagi kod **yagona manba** —
> bu yerda nusxa saqlanmaydi, chunki ikki joydagi schema muqarrar
> ravishda ajralib ketadi.
>
> Tekshirish: `npx prisma validate`

### Kanal / channel manager (TZ 12, 13-band)

| Model | Vazifasi | TZ bandi |
|---|---|---|
| `Channel` | Kanal ta'rifi (`beds24`, kelajakda boshqalar) | 12, 13 |
| `ChannelConnection` | Credentials — shifrlangan, frontendga chiqmaydi | 13, 18 |
| `ChannelMapping` | RoomType/Room ↔ tashqi kanal mapping | 5, 13 |
| `WebhookEvent` | Kiruvchi webhook + duplicate himoyasi | 9, 10 |
| `SyncLog` | Har sync harakati (8 maydon) | 16 |
| `SyncState` | Polling fallback uchun oxirgi nuqta | 10 |

### Foydalanuvchi va audit (TZ 18-band)

| Model | Vazifasi | TZ bandi |
|---|---|---|
| `User` | JWT autentifikatsiya, RBAC | 18 |
| `AuditLog` | Kim, qachon, nima o'zgartirdi | 18 |
| `Settings` | `SOURCE_OF_TRUTH_*` va boshqa sozlamalar | 7 |

### Mehmonxona asosiy modellari (TZ 13-band)

| Model | Vazifasi | TZ bandi |
|---|---|---|
| `RoomType` | Xona turi (`standard`/`double`/`deluxe`) | 5, 13 |
| `Room` | Jismoniy xona — **`id` = xona raqami** (`"101"`) | 5, 13 |
| `Guest` | Mehmon ma'lumotlari | 1, 13 |
| `Reservation` | Bron — 6 status, duplicate constraint | 1, 8, 9 |
| `Charge` | Qo'shimcha xarajat (minibar va h.k.) | 14 |
| `Payment` | To'lov, reversal manfiy summa | 14 |
| `RatePlan` | Kunlik tarif (roomType + sana) | 7 |
| `Availability` | Room type darajasidagi bo'sh xonalar **soni** | 6, 13 |
| `RoomDayStatus` | Xona darajasidagi kunlik holat (ta'mir va h.k.) | 6 |

**TZ 13-band 12 ta jadvalni talab qiladi — hammasi bor.** Qolgan 6 tasi
boshqa bandlar talabi: `SyncState` (10-band polling), `AuditLog` +
`User` (18-band RBAC/audit), `Settings` (7-band source-of-truth),
`RoomDayStatus` (6-band xona darajasi), `Charge` (14-band, Shaxmatkada
mavjud).

### Enum'lar

| Enum | Qiymatlar |
|---|---|
| `WebhookStatus` | RECEIVED, QUEUED, PROCESSED, FAILED, IGNORED_DUPLICATE, NEEDS_MANUAL_ACTION |
| `SyncStatus` | SUCCESS, FAILED, RETRYING, SKIPPED |
| `SyncDirection` | PMS_TO_CHANNEL, CHANNEL_TO_PMS |
| `UserRole` | ADMIN, MANAGER, STAFF |
| `RoomStatus` | AVAILABLE, RESERVED, OCCUPIED, DIRTY, OUT_OF_ORDER, OUT_OF_SERVICE |
| `ReservationSource` | DIRECT, WEBSITE, BOOKING_COM, AIRBNB, EXPEDIA, PHONE, WALK_IN, OTHER |
| `ReservationStatus` | PENDING_PAYMENT, CONFIRMED, CHECKED_IN, CHECKED_OUT, CANCELLED, NO_SHOW |
| `EntitySyncStatus` | PENDING, SYNCED, FAILED, NOT_APPLICABLE |

`RoomStatus`, `ReservationSource` va `ReservationStatus` qiymatlari
Shaxmatka frontendidagi `ROOM_STATUS`, `SOURCES`, `RES_STATUS`
obyektlari bilan **aynan bir xil** (kichik harfga o'giriladi).

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

Natijada turlar bo'yicha:

| Tur | Xonalar | Jami |
|---|---|---|
| `standard` | 101, 102, 105, 107, 109, 111 | **6** |
| `double` | 103, 104, 108, 112 | **4** |
| `deluxe` | 106, 110 | **2** |

Bu sonlar `Availability.totalRooms` ning boshlang'ich qiymati bo'ladi va
agregatsiya mantig'ini tekshirishda ishlatiladi — tafsilot:
[07 §2 Agregatsiya formulasi](07-AVAILABILITY-VA-RATES-SYNC.md).

> ⚠️ Bu uchta son butun to'plamda bir xil bo'lishi shart (6/4/2).
> `check-docs.sh` ularni avtomatik solishtiradi.

`RoomType` seed: `standard` (×1.0), `double` (×1.2), `deluxe` (×1.5) —
Shaxmatkadagi `ROOM_TYPES` bilan aynan bir xil.

---

## Bu faylga tayanadi

Schema o'zgarsa — quyidagilar tekshirilishi shart:

| Fayl | Nimaga tayanadi |
|---|---|
| [04 §4](04-WEBHOOK-HANDLER.md) | `Reservation`, `Guest`, `WebhookEvent` yaratish |
| [06 §5](06-XONA-MAPPING.md) | `ChannelMapping`, `Room` tanlash |
| [07 §2](07-AVAILABILITY-VA-RATES-SYNC.md) | `Availability`, `RoomDayStatus` agregatsiya |
| [08 §6](08-RESERVATION-STATUS-VA-TOLOV.md) | `Payment`, `Charge`, status enum |
| [12 §3](12-PMS-DAN-BEDS24-GA-SYNC.md) | `Reservation.syncStatus`, payload maydonlari |
| [13 §4](13-WEBSITE-INTEGRATSIYA.md) | `Reservation` yaratish, `PENDING_PAYMENT` |
| [10 §5](10-SECURITY-VA-SYNCLOG.md) | `SyncLog`, `AuditLog` maydonlari |
