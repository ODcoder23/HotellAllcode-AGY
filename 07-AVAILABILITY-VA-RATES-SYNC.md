# 07 — Availability va Rates sinxronizatsiyasi

> **Manba:** `TZ-ASL.md` **6-band** (availability sync), **7-band**
> (rates sync), **3-band** (overbooking), **20-band** (bir xil inventory).
> Mijoz qarorlari: **Q1/Q2** (har xona alohida, o'z ID raqami bilan).


**Bu fayl javob beradi:**

- Beds24'ga nechta bo'sh xona yuboriladi?
- Overbooking qanday to'xtatiladi?
- Narxni kim belgilaydi?
- Narxlar paneli qanday ko'rinadi?

---

## 1. Ikki daraja — va ular orasidagi ko'prik

TZ ikkita narsani bir vaqtda talab qiladi:

- **5-band:** `Deluxe → Room 202` — ya'ni **aniq xona** darajasida mapping
- **6-band:** "availability kamayadi / qayta oshadi" — ya'ni **son**

Beds24 esa availability'ni room type bo'yicha **son** shaklida qabul
qiladi (`numAvail`). Shuning uchun tizim ikki darajada ishlaydi:

```
┌──────────────────────────────────────────────────────┐
│  PMS ICHIDA — aniq xona darajasi (haqiqat manbai)     │
│                                                        │
│  15-sentabr:  101 ██band   102 ░bo'sh   105 ░bo'sh    │
│               107 ░bo'sh   109 ██band   111 ░bo'sh    │
│  (standard turida 6 xona: 2 band, 4 bo'sh)            │
└───────────────────────┬──────────────────────────────┘
                        │  AGREGATSIYA
                        ▼
┌──────────────────────────────────────────────────────┐
│  BEDS24'GA — room type darajasi (son)                 │
│                                                        │
│  POST /inventory/rooms/calendar                        │
│  { roomId: <standard>, from: "2026-09-15",            │
│    numAvail: 4 }                                       │
└──────────────────────────────────────────────────────┘
```

Bu ikkisi zid emas: ikkinchisi birinchisidan **hisoblab chiqariladi**,
hech qachon qo'lda yozilmaydi. Shaxmatkada esa admin har doim aniq
xonani ko'radi (mijoz qarori Q1).

---

## 2. Agregatsiya formulasi

```ts
// services/availability/calculate.ts
async function calculateAvailability(roomTypeId: string, date: Date) {
  // 1) Shu turdagi faol xonalar
  const rooms = await prisma.room.findMany({
    where: { roomTypeId, isActive: true },
  });
  const totalRooms = rooms.length;

  // 2) Shu kunga band bo'lganlar.
  //    Chegara qoidasi: checkIn kiradi, checkOut kirmaydi — '[)'
  //    (Shaxmatkadagi `ci < rco && co > rci` mantig'i bilan bir xil)
  const bookedRooms = await prisma.reservation.count({
    where: {
      room: { roomTypeId },
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      checkIn:  { lte: date },
      checkOut: { gt:  date },
    },
  });

  // 3) Ta'mir / xizmatdan chiqarilganlar
  const blockedRooms = await prisma.roomDayStatus.count({
    where: { room: { roomTypeId }, date, isBlocked: true },
  });

  const availableCount = Math.max(
    0, totalRooms - bookedRooms - blockedRooms
  );

  return { totalRooms, bookedRooms, blockedRooms, availableCount };
}
```

**Nega `Availability` jadvali kerak** (TZ 13-band uni talab qiladi):
qiymatni har safar qayta hisoblash mumkin, lekin jadval ikki ishni
bajaradi — (a) Beds24'ga **oxirgi yuborilgan** qiymatni eslab qoladi
(`syncedCount`), shuning uchun o'zgarmagan kunlar qayta yuborilmaydi
(kredit tejaladi), (b) drift tekshiruvi uchun asos bo'ladi (§6).

### Seed ma'lumotlaridagi haqiqiy sonlar

12 xona quyidagicha taqsimlanadi:

| Tur | Xonalar | Jami |
|---|---|---|
| `standard` | 101, 102, 105, 107, 109, 111 | **6** |
| `double` | 103, 104, 108, 112 | **4** |
| `deluxe` | 106, 110 | **2** |

Ya'ni hech bir kun uchun `numAvail` bu sonlardan oshmasligi kerak —
bu FAZA 9 testining asosiy tekshiruvi.

---

## 3. Trigger'lar — availability qachon qayta hisoblanadi

TZ 6-band: *"Har bir o'zgarish queue orqali yuborilsin."*

| Hodisa | Qaysi oraliq qayta hisoblanadi |
|---|---|
| Shaxmatkada yangi bron | `checkIn` … `checkOut` |
| Website'dan bron | `checkIn` … `checkOut` |
| Beds24/OTA'dan bron keldi | `checkIn` … `checkOut` |
| Bron bekor qilindi | `checkIn` … `checkOut` (bo'shaydi) |
| Sana o'zgardi | **eski ∪ yangi** oraliq ([12 §5](12-PMS-DAN-BEDS24-GA-SYNC.md)) |
| Xona almashdi (tur o'zgarsa) | **ikkala tur** uchun ([12 §4](12-PMS-DAN-BEDS24-GA-SYNC.md)) |
| Xona `OUT_OF_ORDER` qilindi | bugundan + N kun oldinga |
| Erta check-out | qolgan kunlar bo'shaydi |
| Xona `isActive=false` | butun kelajak oraliq |

```ts
await availabilitySyncQueue.add("sync", {
  roomTypeIds: ["standard"],
  from: "2026-09-15",
  to:   "2026-09-20",
  reason: "reservation_created",
});
```

---

## 4. Beds24'ga yuborish

```ts
// services/beds24/calendar.ts
async function pushAvailability(roomTypeId, from, to) {
  const mapping = await getRoomTypeMapping(roomTypeId);
  if (!mapping) {
    // [06 §3](06-XONA-MAPPING.md) — taxminiy mapping ASLO ishlatilmaydi
    await syncLog.fail("push_availability", null, "mapping topilmadi");
    return;
  }

  const days = await recalculateRange(roomTypeId, from, to);

  // Faqat Beds24'dagi qiymatdan FARQ QILADIGAN kunlar yuboriladi
  const changed = days.filter(d => d.availableCount !== d.syncedCount);
  if (changed.length === 0) {
    await syncLog.skip("push_availability", "o'zgarish yo'q");
    return;
  }

  // Ketma-ket kunlarni bitta oraliqqa yig'ish (kredit tejash)
  const ranges = groupConsecutive(changed);

  await beds24Client.post("/inventory/rooms/calendar", [{
    roomId: Number(mapping.externalRoomTypeId),
    calendar: ranges.map(r => ({
      from: r.from,
      to:   r.to,
      numAvail: r.availableCount,
    })),
  }]);

  await markSynced(roomTypeId, changed);
}
```

**Uch daraja kredit tejash** ([03 §3](03-BEDS24-API-INTEGRATSIYA.md) dagi 100 kredit / 5 daqiqa
cheklovi sababli):

1. O'zgarmagan kunlar umuman yuborilmaydi (`syncedCount` solishtiruvi)
2. Ketma-ket bir xil qiymatli kunlar bitta oraliqqa yig'iladi
3. 2–3 soniyalik debounce oynasida bir necha o'zgarish birlashadi

---

## 4.1. Amalga oshirilgan holat (FAZA 9 — bajarildi)

Kod joylashuvi:

| Fayl | Vazifasi |
|------|----------|
| `backend/src/services/availability.ts` | Hisoblash, o'qish, yuborish, navbat |
| `backend/src/lib/syncLog.ts` | SyncLog yozish (ikki yo'nalish uchun) |
| `backend/src/queues/workers.ts` | `availabilitySyncWorker` |
| `backend/src/availability.test.ts` | 22 test |

`onAvailabilityChanged()` — bron amallari chaqiradigan yagona kirish
nuqtasi. Tartibi: `recalcAvailability` → `notifyAvailability` (WebSocket)
→ `enqueueAvailabilitySync` (Beds24 navbati). Uchinchisi sekin, shuning
uchun oxirida va navbat orqali.

Ulangan trigger'lar (§3 jadvalidagi hammasi):
`reservation_created`, `room_changed`, `dates_changed`, `checked_out`,
`reservation_cancelled`, `no_show`, `ota_reservation_created`,
`ota_reservation_updated`.

**Debounce `jobId` tuzilishi.** `avail_<turlar>_<from>_<to>_<oyna>`,
bunda `<oyna> = floor(Date.now() / 3000)`. Ikki nozik jihat:

- BullMQ `jobId`da `:` belgisini qabul qilmaydi (Redis kalitlarida
  ajratgich) — shuning uchun `_`.
- Oyna raqami **shart**. BullMQ tugagan job'ni 24 soat saqlaydi
  (`removeOnComplete.age`) va o'sha `jobId`li yangi job'ni jim rad
  etadi. Oyna raqamisiz bir marta yuborilgan oraliq bir sutka
  davomida qayta yuborilmas edi: bron bekor qilinsa Beds24 eski
  sonni ko'rib qolardi. Bu TZ 6-bandning buzilishi bo'lardi va
  regressiya testi bilan qo'riqlanadi.

**OTA bronidan keyin qayta yuborish.** Booking.com'dan bron kelganda
ham Beds24'ga yuboriladi — qolgan kanallar (Airbnb, Expedia, o'z sayt)
hali eski sonni ko'radi (TZ 20-band). Cheksiz sikl xavfi yo'q:
`syncedCount` solishtiruvi o'zgarmagan kunni yubormaydi, ya'ni
zanjir ikkinchi qadamda to'xtaydi.

**Mapping yo'q bo'lsa** job `failed` bo'ladi va admin `sync.failed`
event'ini oladi. Qayta urinish yordam bermaydi — admin
`/admin/mapping` sahifasida bog'lashi kerak (06-fayl §3).

---

## 5. Overbooking'ning oldini olish (TZ 3-band)

TZ: **"OVERBOOKING BO'LMASLIGI SHART."**

Buni faqat dastur mantig'iga ishonib qo'yib bo'lmaydi — ikki parallel
so'rov bir vaqtda tekshiruvdan o'tib ketishi mumkin. Shuning uchun
himoya **uch qatlamli**:

### 1-qatlam: DB constraint (asosiy kafolat)

```sql
EXCLUDE USING gist (
  "roomId" WITH =,
  daterange("checkIn", "checkOut", '[)') WITH &&
) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'))
```

Bu PostgreSQL darajasidagi **jismoniy** to'siq. Dastur mantig'i xato
qilsa ham, ikki parallel so'rov bir vaqtda kelsa ham — ikkinchisi
`23P01` xatosi bilan rad etiladi. To'liq matni: [02 §2](02-DATABASE-SXEMA.md).

### 2-qatlam: Transaction ichida tekshiruv

```ts
await prisma.$transaction(async (tx) => {
  const conflict = await tx.reservation.findFirst({
    where: {
      roomId, status: { notIn: ["CANCELLED", "NO_SHOW"] },
      checkIn: { lt: checkOut }, checkOut: { gt: checkIn },
    },
  });
  if (conflict) throw new RoomUnavailableError();

  const res = await tx.reservation.create({ data: {...} });
  await tx.room.update({ where: { id: roomId }, data: { status: "RESERVED" }});
  return res;
}, { isolationLevel: "Serializable" });
```

Bu qatlam foydalanuvchiga **tushunarli xato** berish uchun (constraint
xatosi texnik ko'rinishda bo'ladi). Shaxmatkadagi mavjud `conflictMsg`
mexanizmi shu xabarni ko'rsatadi.

### 3-qatlam: Beds24'ga darhol xabar

Bron yaratilgan zahoti `availability-sync` navbatga tushadi.

**Halol e'tirof.** Beds24 → OTA orasida bir necha soniya–daqiqa
kechikish bor va uni texnik jihatdan yo'qotib bo'lmaydi (bu OTA'larning
o'z sinxronizatsiya tezligi). Shuning uchun asosiy himoya — **PMS
ichki tizimining o'zi hech qachon bir xonani ikki mijozga bermasligi**.
1-qatlam buni 100% kafolatlaydi.

### Juda kam ehtimolli holat

Xuddi shu soniyalarda Website'dan ham, Booking.com'dan ham oxirgi
xonaga bron kelsa:

```
1. Ikkala bron ham PMS'ga yoziladi — ammo turli xonalarga
   (agar turda bo'sh xona bo'lsa — muammo yo'q)
2. Agar butun turda bitta xona qolgan bo'lsa:
   → constraint ikkinchisini rad etadi
   → OTA'dan kelgan bo'lsa: WebhookEvent.status = NEEDS_MANUAL_ACTION
   → Admin'ga WebSocket orqali ogohlantirish yuboriladi
   → Bron YO'QOLMAYDI — rawPayload to'liq saqlanadi
```

OTA bronini avtomatik rad etish **qilinmaydi** — bu OTA qoidalariga zid
va jarima keltirishi mumkin. Qaror admin'ga qoldiriladi.

---

## 6. Drift tekshiruvi (TZ 20-band: "bir xil inventory")

TZ yakuniy natija sifatida barcha tizimlar bir xil inventory asosida
ishlashini talab qiladi. Uzoq ishlaganda kichik farqlar to'planishi
mumkin (yuborilmay qolgan job, Beds24 tomonidagi qo'lda o'zgarish).

Kuniga bir marta (kam yuklamali vaqtda) **reconciliation** job:

```
1. GET /inventory/rooms/calendar  — Beds24'dagi joriy holat (30 kun)
2. PMS'dagi hisoblangan qiymat bilan solishtiriladi
3. Farq topilsa:
   - SyncLog: action="drift_detected", request=PMS, response=Beds24
   - PMS qiymati to'g'ri deb hisoblanadi (SOURCE_OF_TRUTH_AVAILABILITY=pms)
   - Avtomatik tuzatuvchi availability-sync job qo'yiladi
   - Admin'ga hisobot (nechta kun farq qilgan)
```

Bu — TZ'da to'g'ridan-to'g'ri yozilmagan, lekin 20-bandning
("BARCHA TIZIMLAR BIR XIL INVENTORY ASOSIDA ISHLASHI KERAK")
amaliy kafolati. Usiz drift sezilmay qoladi.

---

## 7. Rates sync (TZ 7-band)

### PMS → Beds24

```
RatePlan.price o'zgardi (admin qo'lda belgilaydi — §8)
        ↓
RatePlan.source = "pms"
        ↓
beds24-rate-sync job
        ↓
POST /inventory/rooms/calendar
  { roomId, calendar: [{ from, to, price1: <narx>, minStay }] }
```

### Beds24 → PMS

TZ 7-band: *"Agar Beds24dan narx o'zgarsa, PMSga ham update kelishi
kerak."* Bu `rate.changed` webhook'i yoki pull orqali keladi va
`SOURCE_OF_TRUTH_RATES` ga bo'ysunadi:

```
SOURCE_OF_TRUTH_RATES = "beds24":
    RatePlan.price yangilanadi, source = "beds24"
    → WebSocket: rate.changed → Admin panelda ko'rinadi

SOURCE_OF_TRUTH_RATES = "pms":
    Narx QABUL QILINMAYDI
    → SyncLog: status=SKIPPED, "pms is source of truth"
    → Qayta yozib yuborilmaydi ham (aks holda cheksiz halqa)
```

**Loop himoyasi.** Ikkala tomon ham bir-birini yangilasa cheksiz halqa
bo'ladi. Shuning uchun:

- Bir vaqtda faqat **bitta** tomon g'olib (`Settings` jadvalida)
- Sozlama o'zgarishi `AuditLog` ga yoziladi (kim, qachon)
- Kelgan qiymat DB'dagi bilan bir xil bo'lsa — hech narsa yozilmaydi

### Ikki xil "narx" — chalkashtirmaslik kerak

| Nima | Nimaga ta'sir qiladi | Endpoint | SoT ga bo'ysunadimi |
|---|---|---|---|
| `Reservation.pricePerNight` | faqat shu bron | `POST /bookings` | ❌ yo'q, har doim yuboriladi |
| `RatePlan.price` | butun room type, kelajak bronlar | `/inventory/rooms/calendar` | ✅ ha |

---

## 8. Narx qanday belgilanadi

**Narxni admin qo'lda belgilaydi.** Avtomatik o'suvchi narx mexanizmi
(`base + confirmedCount × increment`) **olib tashlanadi** — mijoz
qarori Q8.

```
Admin narxni belgilaydi (Shaxmatka → Narxlar paneli)
        ↓
RatePlan.price yangilanadi, source = "pms"
        ↓
beds24-rate-sync job (SOURCE_OF_TRUTH_RATES = "pms" bo'lsa)
        ↓
Beds24 → OTA
```

### Nega avtomatik mexanizm olib tashlandi

Mavjud frontendda ishlaydigan formula:

```js
currentBasePrice = clamp(base + confirmedCount * increment, min, max)
```

`confirmedCount` faqat **o'sadi**, hech qachon kamaymaydi. Natijada
narx bir tomonga surilib, `max` qiymatiga tegib qotib qolardi:

| Bronlar soni | Standart xona narxi |
|---|---|
| 4 (boshlang'ich) | $70 |
| 9 | $120 |
| 14 | $170 |
| 17+ | **$200** — shift, o'zgarmaydi |

Bu Beds24 orqali OTA'ga chiqsa, Booking.com'dagi narx har brondan
keyin ko'tarilib, sotilmaydigan darajaga yetardi. Uch sabab bilan
olib tashlandi: TZ'da bunday mexanizm yo'q; formula xato (to'g'ri
occupancy pricing **sanadagi bandlik foiziga** qarashi kerak, jami
bronlar soniga emas); va yangi biznes-mantiq qo'shish TZ doirasidan
tashqarida.

### Narxlar paneli — UI spetsifikatsiyasi

Frontenddagi `PricingPanel` komponenti **saqlanib qoladi** (TZ "qayta
yasamang"), lekin mazmuni o'zgaradi: avtomatik hisoblash o'rniga
`RatePlan` narxlarini ko'rsatadi va tahrirlashga imkon beradi.

```
┌─ Narxlar ───────────────────────────┐
│ Sana: [15 sen] – [20 sen]           │
├─────────────────────────────────────┤
│ Standart       [ $35 ]  ● yuborildi │
│ Ikki kishilik  [ $42 ]  ○ kutmoqda  │
│ Lyuks          [ $52 ]  ⚠ xato [↻]  │
├─────────────────────────────────────┤
│ ⚠ O'zgarish Beds24 → OTA'ga ketadi  │
│              [Bekor]   [Saqlash]    │
└─────────────────────────────────────┘
```

**Olib tashlanadigan elementlar** (mexanizm bilan birga ma'nosini
yo'qotadi): `enabled` toggle, "Har bir bron narxni oshiradi" izohi,
"Har bir bron uchun oshirish" selecti, min/maks narx maydonlari,
"Tasdiqlangan bronlar" hisoblagichi, "Keyingi bron narxi" qatori.

**Qoladigan element:** uch xona turi va ularning narxlari — endi
tahrirlanadigan holda.

### Saqlash oqimi va sync holati

TZ 17-bandi admin Beds24'ni kutmasligini talab qiladi, lekin admin
OTA'da narx yangilanganini **ko'rishi** kerak — aks holda eski narxda
bron kelib qolishi mumkin.

```
"Saqlash" bosildi
        ↓
RatePlan DB'ga yoziladi (millisekundlar)
        ↓
✓ "Saqlandi" — panel yopiladi          ← admin kutmaydi
        ↓
(fonda) beds24-rate-sync → retry → retry
        ↓
WebSocket: rate.sync.updated → panel holati yangilanadi
```

Panel qayta ochilganda har narx yonida holat ko'rinadi:

| Belgi | Ma'nosi | Manba |
|---|---|---|
| ● yuborildi | Beds24 qabul qildi | `RatePlan.syncedAt` bor |
| ○ kutmoqda | Navbatda turibdi | job bor, `syncedAt` yo'q |
| ⚠ xato | 5 urinish ham bo'lmadi | `SyncLog.status = FAILED` |

Xato holatida `[↻]` tugmasi job'ni qayta navbatga qo'yadi.

**Interaction state'lar:**

| Holat | Ko'rinish |
|---|---|
| Loading | Narx maydonlari o'rniga skeleton |
| Empty | `RatePlan` yo'q → "narx belgilanmagan", input bo'sh |
| Error | Saqlash muvaffaqiyatsiz → qizil xabar, qiymatlar saqlanadi |
| Success | ✓ "Saqlandi", 2 soniyada yo'qoladi |
| Partial | DB saqlandi, Beds24 kutmoqda → ○ belgisi |

> Bu — Shaxmatka frontendidagi **ikkinchi va oxirgi** o'zgartirish
> ([00-INDEX](00-INDEX.md) qoida 1). Birinchisi — `RES_STATUS` ga ikki
> status qo'shish ([08 §1](08-RESERVATION-STATUS-VA-TOLOV.md)).
> Boshqa komponentlarga tegilmaydi.

---

## 8.1. Amalga oshirilgan holat (FAZA 11 — bajarildi)

Kod joylashuvi:

| Fayl | Vazifasi |
|------|----------|
| `backend/src/services/rates.ts` | pushRates, applyExternalRate, navbat |
| `backend/src/services/settings.ts` | source of truth (DB'da, `.env` emas) |
| `backend/src/routes/rates.ts` | GET/PUT narx, POST /resync |
| `backend/src/rates.test.ts` | 26 test |
| `index (7).html` | `PricingPanel` qayta yozildi |

**Source of truth DB'da saqlanadi**, `.env` da emas. Sabab: qiymat
ishlash paytida o'zgarishi mumkin (admin panelda tugma), `.env`
o'zgarishi esa serverni qayta ishga tushirishni talab qiladi — bu
ishlab turgan mehmonxonada qabul qilib bo'lmaydi. `.env` qiymati
boshlang'ich qiymat sifatida qoladi: DB'da yozuv bo'lmasa o'sha
olinadi. Endpoint: `GET/PUT /api/admin/settings`.

**Loop himoyasi uch qatlam** (tekshirilgan):

1. Bir vaqtda bitta tomon g'olib. `SoT = pms` bo'lsa Beds24'dan
   kelgan narx rad etiladi va — muhimi — **javob qaytarilmaydi**.
   Test buni aniq tekshiradi: Beds24 narx yuborgandan keyin
   `calendarPushes` bo'sh qoladi.
2. Yutqazgan tomon `SyncLog` ga `SKIPPED` yozadi, hech narsa
   o'zgartirmaydi.
3. Kelgan qiymat DB'dagi bilan bir xil bo'lsa hech narsa yozilmaydi.

**Beds24'dan kelgan narx `syncedAt` bilan yoziladi** — ya'ni
allaqachon sinxron deb belgilanadi. Aks holda keyingi push uni
"yuborilmagan" deb ko'rib Beds24'ga qaytarardi: halqa.

**Frontend o'zgarishi.** `PricingPanel` avtomatik hisoblash
o'rniga `RatePlan` narxlarini tahrirlaydi (Q8). Eski mexanizm
(`base + confirmedCount × increment`) butunlay olib tashlandi:
`priceForType` endi `RatePlan` dan o'qiydi, `pricing` state'i yo'q.
Toolbar tugmasi hisoblangan narx o'rniga "Narxlar" yozuvini
ko'rsatadi.

Panel holat belgilari (§8 jadvali) ishlaydi: yashil = Beds24 qabul
qildi, kulrang = navbatda, qizil + [↻] = xato. Qayta yuborish
`POST /api/rate-plans/resync` orqali.

**Ishlatilmagan `PayPill` komponenti olib tashlandi.** U hech qayerda
chaqirilmas edi; TZ 14-band talab qilgan to'lov ko'rsatkichi
allaqachon ikki joyda ishlaydi — bron kartochkasida qarz summasi
yoki ✓ belgisi, detail modalda "To'langan" va "Qoldiq" qatorlari.

**Tekshirilgan zanjir (brauzer + mock):** Narxlar panelida Standart
narxi 58 qilib saqlandi -> mock Beds24 `price1 = 58` oldi, 7 kunlik
oraliq bitta push'ga yig'ildi -> panel qayta ochilganda Standart
yonida yashil "Beds24 qabul qildi" belgisi.

---

## 9. Xato holatida (TZ 6, 17-band)

TZ 6-band: *"Temporary API xatosi PMS ishini to'xtatmasin."*

```
Availability o'zgardi
  ↓
DB yangilandi (darhol, ichki holat to'g'ri)   ← PMS uchun yetarli
  ↓
Job navbatga (fire-and-forget)
  ↓
Beds24 javob bermadi → retry → retry → retry ([05 §3](05-SYNC-QUEUE-BULLMQ.md))
  ↓
5 urinish ham bo'lmasa → SyncLog: FAILED, Admin ko'radi
```

Bu vaqt ichida:
- Shaxmatka, Website, Admin Panel — **to'liq ishlaydi**
- Overbooking xavfi **yo'q** (PMS ichki himoyasi mustaqil)
- Faqat OTA tomonidagi ko'rinish kechikadi
- Beds24 qaytganda navbat o'z-o'zidan bo'shaydi (TZ 17-band)

---

## Bu faylga tayanadi

Agregatsiya yoki overbooking qoidasi o'zgarsa — tekshirilishi shart:

| Fayl | Nimaga tayanadi |
|---|---|
| [02 §2](02-DATABASE-SXEMA.md) | Exclusion constraint — bir xil chegara qoidasi `'[)'` |
| [04 §4](04-WEBHOOK-HANDLER.md) | Webhook'dan keyin availability qayta hisoblash |
| [12 §4-5](12-PMS-DAN-BEDS24-GA-SYNC.md) | Xona/sana o'zgarganda qaysi oraliq qayta hisoblanadi |
| [13 §2](13-WEBSITE-INTEGRATSIYA.md) | Public API'da bo'sh xonalar soni |
| [11 FAZA 2B, 9](11-BOSQICHLAR-ROADMAP.md) | Overbooking testi va availability sync |
