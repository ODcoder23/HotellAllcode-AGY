# 12 — PMS → Beds24 yo'nalishi (Shaxmatka o'zgarishlarini sinxronlash)

> **Manba:** `TZ-ASL.md` **2-band** — Shaxmatkadagi 8 ta amal Beds24
> bilan sinxronlanadi. Mijoz qarorlari: **Q6** (xona almashsa Beds24'da
> ham ko'rinadi), **Q7** (check-in/check-out qo'llab-quvvatlanadi).

Bu hujjat TZ 2-bandining to'liq texnik yoyilmasi. Boshqa hujjatlarda
`beds24-reservation-sync` navbati faqat nomi bilan tilga olingan edi —
uning **mazmuni shu yerda**.


**Bu fayl javob beradi:**

- Shaxmatkadagi o'zgarish Beds24'ga qanday boradi?
- Xona almashtirilsa nima bo'ladi?
- Check-in Beds24'ga yuboriladimi?
- Cheksiz halqa qanday oldi olinadi?

---

## 1. TZ 2-band: sakkiz amalning to'liq jadvali

Har bir amal uchun: Beds24'ga nima yuboriladi, qaysi navbat orqali,
availability ham o'zgaradimi.

| № | Shaxmatkadagi amal | Frontend funksiyasi | Beds24'ga yuboriladi | Navbat | Availability ham? |
|---|---|---|---|---|---|
| 1 | Yangi bron yaratish | `createReservation()` | `POST /bookings` — yangi booking | `reservation-sync` | ✅ ha |
| 2 | Bronni o'zgartirish | `updateReservation()` | `POST /bookings` — `id` bilan update | `reservation-sync` | holatiga qarab |
| 3 | **Xonani almashtirish** | `changeRoom()` | `POST /bookings` — `roomId`/`unitId` o'zgaradi | `reservation-sync` | ✅ ha (§4) |
| 4 | Sanani o'zgartirish | `changeDates()` | `POST /bookings` — `arrival`/`departure` | `reservation-sync` | ✅ ha (§5) |
| 5 | Mehmon sonini o'zgartirish | detail modal | `POST /bookings` — `numAdult`/`numChild` | `reservation-sync` | ❌ yo'q |
| 6 | Narxni o'zgartirish | detail modal | `POST /bookings` — `price` | `reservation-sync` | ❌ yo'q |
| 7 | Bronni bekor qilish | `cancelRes()` | `POST /bookings` — `status: cancelled` | `reservation-sync` | ✅ ha (bo'shaydi) |
| 8 | **Check-in / check-out** | `checkIn()` / `checkOutRes()` | `POST /bookings` — status/flag (§6) | `reservation-sync` | check-out'da ✅ |

**Qoida:** bitta foydalanuvchi amali → bitta `reservation-sync` job
(+ kerak bo'lsa `availability-sync` job). Ikkalasi alohida navbatda,
chunki biri muvaffaqiyatsiz bo'lsa ikkinchisi baribir ketishi kerak.

---

## 2. Job payload'i — yagona shakl

Barcha 8 amal bitta job turini ishlatadi. Bu qasddan: mantiq bitta
joyda turadi, yangi amal qo'shilsa `changeType` kengayadi xolos.

```ts
// queues/payloads.ts
type ReservationSyncJob = {
  reservationId: string;          // PMS ichki id — tabiiy kalit
  changeType:
    | "created" | "updated" | "room_changed" | "dates_changed"
    | "guests_changed" | "price_changed" | "cancelled"
    | "checked_in" | "checked_out";
  previousState?: {               // faqat availability uchun kerak bo'lganda
    roomId?: string;
    checkIn?: string;             // "YYYY-MM-DD"
    checkOut?: string;
  };
  triggeredBy: string;            // userId — AuditLog uchun
  requestedAt: string;            // ISO — eskirgan job'ni aniqlash uchun
};
```

**Idempotentlik (TZ 11-band retry talabi bilan bog'liq).** Worker
job payload'idagi ma'lumotga emas, **DB'dagi joriy holatga** qarab
ish ko'radi:

```
Worker ishga tushdi
  ↓
Reservation'ni DB'dan QAYTA o'qiydi (payload'dagi eski nusxani emas)
  ↓
Joriy holatni Beds24'ga to'liq yuboradi ("shu bron hozir mana bunday")
```

Natijada job ikki marta bajarilsa ham natija bir xil. Job navbatda
turganda bron yana o'zgarsa — worker eng oxirgi holatni yuboradi,
eskisini emas. Bu "delta yuborish" ga qaraganda ancha ishonchli.

---

## 3. Beds24 `POST /bookings` chaqiruvi

```ts
// services/beds24/bookings.ts
async function pushReservation(reservationId: string) {
  const res = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: { guest: true, room: { include: { roomType: true } },
               payments: true, charges: true },
  });

  // 1) Mapping majburiy — topilmasa sync RAD ETILADI ([06 §3](06-XONA-MAPPING.md))
  const mapping = await resolveMapping(res.room);
  if (!mapping) {
    await syncLog.fail("push_reservation", res.id, "mapping topilmadi");
    await prisma.reservation.update({
      where: { id: res.id },
      data: { syncStatus: "NOT_APPLICABLE" },
    });
    return; // retry qilinmaydi — mapping o'z-o'zidan paydo bo'lmaydi
  }

  // 2) Payload
  const body = [{
    ...(res.externalReservationId
        ? { id: Number(res.externalReservationId) }   // update
        : { roomId: Number(mapping.externalRoomTypeId) }), // create
    ...(mapping.externalUnitId && { unitId: Number(mapping.externalUnitId) }),
    status:     toBeds24Status(res.status),    // [08 §1](08-RESERVATION-STATUS-VA-TOLOV.md)
    arrival:    fmtDate(res.checkIn),          // "YYYY-MM-DD"
    departure:  fmtDate(res.checkOut),
    numAdult:   res.adults,
    numChild:   res.children,
    price:      Number(res.pricePerNight) * nights(res),
    firstName:  splitName(res.guest.fullName).first,
    lastName:   splitName(res.guest.fullName).last,
    phone:      res.guest.phone ?? undefined,
    email:      res.guest.email ?? undefined,
    notes:      res.notes ?? undefined,
    referer:    "PMS",
  }];

  const result = await beds24Client.post("/bookings", body);

  // 3) Birinchi marta yaratilgan bo'lsa — bookingId'ni saqlab qo'yamiz
  if (!res.externalReservationId && result[0]?.new?.id) {
    await prisma.reservation.update({
      where: { id: res.id },
      data: {
        externalReservationId: String(result[0].new.id),
        channelId: beds24ChannelId,
        syncStatus: "SYNCED",
        lastSyncedAt: new Date(),
      },
    });
  }
}
```

**Muhim nuqta — echo loop'ning oldini olish.** PMS Beds24'ga bron
yuborgach, Beds24 o'sha bron haqida bizga webhook qaytaradi. Agar
himoya bo'lmasa: webhook → PMS yangilanadi → yana sync → yana webhook…
cheksiz halqa.

Yechim — **ikki qatlamli**:

1. `referer: "PMS"` maydoni — webhook'da shu qiymat kelsa, o'zimizning
   aks-sadomiz ekani ma'lum bo'ladi.
2. `payloadHash` solishtiruvi — kelgan ma'lumot DB'dagi holat bilan
   bir xil bo'lsa, hech narsa yozilmaydi, `SyncLog.status = SKIPPED`.

Ikkinchisi asosiy himoya, birinchisi qo'shimcha — chunki `referer`
maydonini Beds24 har doim ham qaytarmasligi mumkin.

---

## 4. Xona almashtirish (TZ 2-band, mijoz qarori Q6)

Eng murakkab amal — ikki xona holati bir vaqtda o'zgaradi.

```
changeRoom(res, "205")
        ↓
  ┌─────────────── bitta DB transaction ───────────────┐
  │ 1. reservation_no_overlap constraint tekshiradi     │
  │    (yangi xona band bo'lsa — 23P01 xato, bekor)     │
  │ 2. Reservation.roomId = "205"                       │
  │ 3. Eski xona (101) holati qayta hisoblanadi         │
  │ 4. Yangi xona (205) holati qayta hisoblanadi        │
  └────────────────────────────────────────────────────┘
        ↓
  Ikkita job navbatga:
    a) reservation-sync  { changeType: "room_changed",
                           previousState: { roomId: "101" } }
    b) availability-sync { roomTypeIds: [eski.turi, yangi.turi],
                           dateRange: [checkIn, checkOut] }
```

**Ikki holatni ajratish kerak:**

| Holat | Beds24'da nima o'zgaradi |
|---|---|
| **Bir tur ichida** (101 → 102, ikkalasi ham `standard`) | Room type availability **o'zgarmaydi** (5 ta xonadan baribir 1 tasi band). Agar unit-level mapping bo'lsa — `unitId` yangilanadi. |
| **Tur o'zgardi** (101 `standard` → 106 `deluxe`) | **Ikki** room type availability bir vaqtda o'zgaradi: `standard` +1 bo'shaydi, `deluxe` −1 kamayadi. Booking'ning `roomId` si ham yangilanadi. |

Ikkinchi holat uchun `availability-sync` job **ikkala turni ham**
o'z ichiga oladi — aks holda Beds24'da eski tur band bo'lib qolib
ketadi va OTA'da sotilmay qoladi.

---

## 5. Sana o'zgarishi

```
changeDates(res, "2026-09-20", "2026-09-25")
```

Availability **eski va yangi oraliqning birlashmasi** bo'yicha qayta
hisoblanadi — faqat yangi oraliq emas:

```
Eski:  15–18  ██████
Yangi: 20–25          ████████
                ↓
Qayta hisoblanadi: 15–25 (butun oraliq)
```

Agar faqat yangi oraliq yuborilsa, eski kunlar (15–18) Beds24'da band
bo'lib qolib ketadi — real sotuv yo'qotiladi. Shuning uchun:

```ts
const from = min(old.checkIn, new.checkIn);
const to   = max(old.checkOut, new.checkOut);
```

---

## 6. Check-in / check-out (TZ 2-band, mijoz qarori Q7)

Mijoz tasdiqladi: **Beds24 buni qo'llab-quvvatlaydi, sync qilinadi.**

```ts
// checkIn()  → Beds24: status = "confirmed" + subStatus/flag = arrived
// checkOut() → Beds24: status = "confirmed" + flag = departed
```

Aniq maydon nomi Beds24 hisobi sozlamasiga qarab farq qilishi mumkin
(`status`, `subStatus`, yoki custom flag). Shuning uchun:

- Mapping **bitta joyda** — `services/beds24/statusMap.ts` ([08 §1](08-RESERVATION-STATUS-VA-TOLOV.md)).
- **FAZA 10** da real `GET /bookings` javobi olinib, aniq maydon nomi
  tasdiqlanadi va `statusMap.ts` shunga moslanadi. Mock bilan emas,
  haqiqiy javob bilan.
- Agar ma'lum bir maydonni Beds24 qabul qilmasa — `SyncLog` ga
  `SKIPPED` + izoh yoziladi, **bron esa PMS'da normal ishlayveradi**
  (TZ 17, 19-band). Ya'ni check-in PMS'da har doim ishlaydi, Beds24
  tomoni esa qo'shimcha.

**Check-out'da availability.** Mehmon rejadan oldin chiqib ketsa
(`checkOut` sanasi qisqartirilsa), qolgan kunlar bo'shaydi va
darhol Beds24'ga yuboriladi — bu real daromad.

---

## 7. Mehmon soni va narx

**Mehmon soni** (`numAdult`/`numChild`) — availability'ga ta'sir
qilmaydi (xona baribir band), lekin **narxga ta'sir qilishi mumkin**
(OTA'larda ko'pincha kishi soniga qarab narx). Shuning uchun har doim
Beds24'ga yuboriladi.

**Narx.** Bu yerda TZ 7-bandidagi source-of-truth qoidasi ishlaydi:

```
SOURCE_OF_TRUTH_RATES = "pms"     → PMS narxi Beds24'ga yuboriladi
SOURCE_OF_TRUTH_RATES = "beds24"  → yuborilmaydi, SyncLog: SKIPPED
```

Diqqat — bu ikki xil narsa:

| Nima | Nimaga ta'sir qiladi | Endpoint |
|---|---|---|
| **Bron narxi** (`Reservation.pricePerNight`) | faqat shu bron | `POST /bookings` |
| **Kunlik tarif** (`RatePlan.price`) | butun room type, barcha kelajak bronlar | `POST /inventory/rooms/calendar` |

Birinchisi har doim yuboriladi (bu bronning haqiqiy summasi).
Ikkinchisi `SOURCE_OF_TRUTH_RATES` ga bo'ysunadi.

---

## 8. Sync holatini kuzatish

Har bron `syncStatus` maydoniga ega ([02](02-DATABASE-SXEMA.md)):

```
PENDING  → navbatda turibdi
SYNCED   → Beds24 qabul qildi
FAILED   → 5 urinish ham natija bermadi
NOT_APPLICABLE → mapping yo'q yoki kanal o'chirilgan
```

Bu maydon API javobida frontendga ham boradi. Shaxmatka hozir uni
ishlatmaydi va e'tiborsiz qoldiradi — lekin kelajakda bron blokida
kichik belgi ("⚠ Beds24'ga yuborilmadi") ko'rsatish uchun tayyor
turadi. **Hozircha frontendga hech qanday o'zgartirish kiritilmaydi.**

---

## 9. Ketma-ketlik kafolati (TZ 20-band "bir xil inventory")

Bitta bron ustida ikki o'zgarish tez ketma-ket qilinsa (masalan sana,
so'ng darhol xona), ular Beds24'ga **to'g'ri tartibda** yetishi kerak.
Aks holda oxirgi holat noto'g'ri bo'lib qoladi.

Yechim — BullMQ **`FlowProducer` yoki per-reservation guruh**:

```ts
await reservationSyncQueue.add(
  "sync",
  payload,
  {
    jobId: `res-${reservationId}-${Date.now()}`,
    // Bir bron uchun bir vaqtda faqat bitta job ishlaydi
    group: { id: `reservation-${reservationId}` },
  }
);
```

Ikkinchi himoya — §2 dagi "DB'dan qayta o'qish" qoidasi: hatto tartib
buzilsa ham, worker eng oxirgi holatni yuboradi, shuning uchun yakuniy
natija baribir to'g'ri bo'ladi.

---

## 10. Xato holati (TZ 17-band)

TZ qat'iy: *"Beds24 vaqtincha ishlamasa — PMS ishlashda davom etishi
kerak."* Shuning uchun **hech qanday** Shaxmatka amali Beds24 javobini
kutmaydi:

```
Admin "Saqlash" bosdi
  ↓
DB transaction (millisekundlar)          ← bu muvaffaqiyatli bo'lsa yetarli
  ↓
Job navbatga qo'yildi (fire-and-forget)
  ↓
Frontendga 200 OK darhol qaytariladi      ← foydalanuvchi kutmaydi
  ↓
(fonda) Worker Beds24'ga yuboradi → retry → retry → retry
```

Beds24 butunlay o'chib qolsa ham: bronlar DB'da to'planadi,
`syncStatus = PENDING` bo'lib turadi, Beds24 qaytganda navbat
o'z-o'zidan bo'shaydi. Bu — TZ 19-bandning ("PMS ichki ishlashi
Beds24ga bog'lanib qolmasin") amaliy ifodasi.
