# 07 — Availability va Rates sinxronizatsiyasi

> **Manba:** `TZ-ASL.md` **6-band** (availability sync), **7-band**
> (rates sync), **3-band** (overbooking), **20-band** (bir xil inventory).
> Mijoz qarorlari: **Q1/Q2** (har xona alohida, o'z ID raqami bilan).

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
│               107 ░bo'sh   109 ██band                  │
│  (standard turida 5 xona: 2 band, 3 bo'sh)            │
└───────────────────────┬──────────────────────────────┘
                        │  AGREGATSIYA
                        ▼
┌──────────────────────────────────────────────────────┐
│  BEDS24'GA — room type darajasi (son)                 │
│                                                        │
│  POST /inventory/rooms/calendar                        │
│  { roomId: <standard>, from: "2026-09-15",            │
│    numAvail: 3 }                                       │
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
| Sana o'zgardi | **eski ∪ yangi** oraliq (`12`-fayl §5) |
| Xona almashdi (tur o'zgarsa) | **ikkala tur** uchun (`12`-fayl §4) |
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
    // 06-fayl §3 — taxminiy mapping ASLO ishlatilmaydi
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

**Uch daraja kredit tejash** (`03`-fayl §3 dagi 100 kredit / 5 daqiqa
cheklovi sababli):

1. O'zgarmagan kunlar umuman yuborilmaydi (`syncedCount` solishtiruvi)
2. Ketma-ket bir xil qiymatli kunlar bitta oraliqqa yig'iladi
3. 2–3 soniyalik debounce oynasida bir necha o'zgarish birlashadi

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
`23P01` xatosi bilan rad etiladi. To'liq matni: `02`-fayl §2.

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

**Narxni admin qo'lda belgilaydi.** Avtomatik/dinamik narxlash
mexanizmi **yo'q** — mijoz qarori bilan olib tashlandi.

```
Admin narxni belgilaydi (Admin panel yoki bron yaratishda)
        ↓
RatePlan.price yangilanadi, source = "pms"
        ↓
beds24-rate-sync job (SOURCE_OF_TRUTH_RATES = "pms" bo'lsa)
        ↓
Beds24 → OTA
```

### Nega olib tashlandi

Mavjud Shaxmatka frontendida quyidagi mexanizm bor edi:

```js
currentBasePrice = clamp(base + confirmedCount * increment, min, max)
```

`confirmedCount` — tasdiqlangan bronlar soni, va u **faqat o'sardi**,
hech qachon kamaymasdi. Natijada narx bir tomonga surilib, `max`
qiymatiga tegib qotib qolardi:

| Bronlar soni | Standart xona narxi |
|---|---|
| 4 (boshlang'ich) | $70 |
| 9 | $120 |
| 14 | $170 |
| 17+ | **$200** — shift, o'zgarmaydi |

Bu Beds24 orqali OTA'ga chiqsa, Booking.com'dagi narx har brondan
keyin ko'tarilib, oxir-oqibat sotilmaydigan darajaga yetardi.

Uch sabab bilan olib tashlandi:

1. **TZ'da bu mexanizm yo'q.** TZ 7-bandi faqat "narx o'zgarsa
   sinxronlashtirilsin" deydi — narxni kim/qanday belgilashi
   haqida hech narsa demaydi.
2. **Formula xato.** To'g'ri occupancy pricing ma'lum **sanadagi
   bandlik foiziga** qarashi kerak (bron bekor bo'lsa narx qaytishi
   kerak), jami bronlar soniga emas.
3. **"Qayta yasamang" qoidasi.** Yangi narxlash mantig'ini yozish —
   mavjud tizimga yangi biznes-mantiq qo'shish, TZ doirasidan tashqari.

### Frontendga ta'siri

`PricingPanel` komponenti va `pricing` state Shaxmatkada qoladi,
lekin narx endi **backenddan** keladi:

```
GET /api/rate-plans?from=...&to=...
  → [{ roomTypeId, date, price, minStay }]
```

Bron yaratishda taklif qilinadigan narx shu jadvaldan olinadi.
Admin uni istalgan vaqtda o'zgartirishi mumkin — `Reservation.pricePerNight`
bron darajasida alohida saqlanadi va `RatePlan` ga bog'liq emas.

> **Eslatma:** Agar kelajakda bandlik asosidagi narxlash kerak bo'lsa —
> `RatePlan` strukturasi `(roomTypeId, date)` bo'yicha allaqachon
> tayyor, faqat hisoblash mantig'i qo'shiladi. Bu **alohida TZ**
> talab qiladi.

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
Beds24 javob bermadi → retry → retry → retry (05-fayl §3)
  ↓
5 urinish ham bo'lmasa → SyncLog: FAILED, Admin ko'radi
```

Bu vaqt ichida:
- Shaxmatka, Website, Admin Panel — **to'liq ishlaydi**
- Overbooking xavfi **yo'q** (PMS ichki himoyasi mustaqil)
- Faqat OTA tomonidagi ko'rinish kechikadi
- Beds24 qaytganda navbat o'z-o'zidan bo'shaydi (TZ 17-band)
