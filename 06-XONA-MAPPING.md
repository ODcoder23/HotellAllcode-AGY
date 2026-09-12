# 06 — Xona (RoomType / Room) mapping

> **Manba:** `TZ-ASL.md` **5-band** — *"Eng muhim qism."*
> Mijoz qarorlari: **Q1** (har xona Shaxmatkada alohida ko'rinadi),
> **Q2** (har xonaning o'z ID raqami bor), **Q3** (Beds24'dan kelgan
> bron xonaga **avtomatik** biriktiriladi).


**Bu fayl javob beradi:**

- PMS xonasi Beds24'dagi qaysi xonaga bog'lanadi?
- Mapping topilmasa nima bo'ladi?
- Beds24'dan kelgan bron qaysi xonaga tushadi?
- Bo'sh xona topilmasa?

---

## 1. TZ nima talab qiladi

TZ 5-band aniq misol beradi:

```
PMS:     Deluxe → Room 202
Beds24:  Deluxe → tegishli Beds24 room/unit
```

Ya'ni mapping **ikki darajali**: tur ↔ tur, va xona ↔ unit.
Va qat'iy qoida: *"Noto'g'ri xona turiga bron tushmasligi kerak."*

**Muhim:** Beds24 tomonida mapping **API orqali sozlanmaydi** — faqat
ularning control panelida qo'lda qilinadi ([03 §2](03-BEDS24-API-INTEGRATSIYA.md)). Bizning
vazifamiz: (a) bu tashqi moslikni ichki tizimda **saqlash**,
(b) har sync operatsiyasida **tekshirish**.

---

## 2. Ikki daraja

```
┌─────────────── DARAJA 1: majburiy ───────────────┐
│  RoomType  ↔  Beds24 roomId                       │
│                                                    │
│  standard  ↔  12345  (Beds24 "Standard Room")     │
│  double    ↔  12346  (Beds24 "Double Room")       │
│  deluxe    ↔  12347  (Beds24 "Deluxe Room")       │
│                                                    │
│  Bu availability va rates sync uchun YETARLI       │
└───────────────────────────────────────────────────┘

┌─────────────── DARAJA 2: ixtiyoriy ──────────────┐
│  Room  ↔  Beds24 unitId                           │
│                                                    │
│  101  ↔  unit-A                                    │
│  102  ↔  unit-B                                    │
│                                                    │
│  Faqat Beds24 hisobi unit-level sozlangan bo'lsa   │
└───────────────────────────────────────────────────┘
```

**Daraja 1 — majburiy.** Usiz hech qanday sync ishlamaydi.

**Daraja 2 — ixtiyoriy.** Beds24 hisobida xonalar alohida unit sifatida
sozlanmagan bo'lsa, bu daraja bo'sh qoladi va tizim faqat 1-daraja
bilan to'liq ishlaydi. Aynan shu sabab `ChannelMapping.externalUnitId`
maydoni `nullable`.

> Beds24 hisobi qaysi rejimda sozlanganini **FAZA 4** da
> `GET /properties` javobidan aniqlaymiz — taxmin qilinmaydi.

---

## 3. Mapping ekrani (backend ichidagi alohida sahifa)

> **Ish chegarasi.** Mavjud Admin Panel kodiga kirish huquqi yo'q,
> shuning uchun mapping ekrani **backend ichida mustaqil sahifa**
> sifatida yoziladi (`/admin/mapping`). Oddiy HTML + `fetch`, framework
> yo'q. Mavjud Admin Panel kodiga **umuman tegilmaydi**.
>
> Nega kerak: TZ 20-band "barcha tizimlar bir xil inventory asosida
> ishlashi kerak" deydi. Mapping kiritilmasa sync rad etiladi (§4) va
> bu talab bajarilmaydi. Mapping'ni `curl` bilan kiritish "ishlaydigan
> tizim" emas.
>
> Keyinroq bu sahifani mavjud Admin Panelga ko'chirish mumkin — API
> o'zgarmaydi.

```
┌──────────────────────────────────────────────────────────┐
│  Beds24 ulanishi:  ● Ulangan     Property: Imron Hotel    │
├──────────────────────────────────────────────────────────┤
│  PMS xona turi      │ Xonalar │ Beds24 room type          │
├──────────────────────────────────────────────────────────┤
│  Standart           │   6     │ [Standard Room    ▾] ✓    │
│  Ikki kishilik      │   4     │ [Double Room      ▾] ✓    │
│  Lyuks              │   2     │ [⚠ tanlanmagan    ▾]      │
├──────────────────────────────────────────────────────────┤
│  ⚠ Lyuks turi mapping qilinmagan — bu turdagi bronlar     │
│    Beds24'ga yuborilmaydi va OTA'da ko'rinmaydi.          │
├──────────────────────────────────────────────────────────┤
│  ▸ Unit darajasidagi mapping (ixtiyoriy)                  │
└──────────────────────────────────────────────────────────┘
```

- Beds24 room type'lari ro'yxati `GET /properties` dan olinadi.
  Bu **yagona joy** — boshqa hech qayerda `/properties` chaqirilmaydi,
  natija cache qilinadi (kamdan-kam o'zgaradi, kredit tejaydi).
- Har o'zgarish `AuditLog` ga yoziladi (TZ 18-band): kim, qachon,
  qaysi mapping'ni nimaga o'zgartirdi.
- Faqat `ADMIN` roli kira oladi (TZ 18-band RBAC).

---

## 4. Mapping yo'q bo'lsa — qat'iy qoida

TZ 5-band: *"Noto'g'ri xona turiga bron tushmasligi kerak."*

**Taxminiy mapping ASLO ishlatilmaydi** — na "eng yaqin tur", na
"standart tur", na "birinchi topilgan". Sabab: noto'g'ri xonaga
tushgan bron real overbooking yoki noto'g'ri narxlash keltiradi, va
buni keyinchalik aniqlash juda qiyin.

### PMS → Beds24 yo'nalishi

```
Mapping topilmadi
   ↓
Sync job BAJARILMAYDI
   ↓
SyncLog: status=FAILED, errorMessage="mapping topilmadi: roomType=deluxe"
   ↓
Reservation.syncStatus = NOT_APPLICABLE
   ↓
Retry QILINMAYDI — mapping o'z-o'zidan paydo bo'lmaydi
   ↓
Admin panelda ogohlantirish ko'rinadi
```

PMS ichida bron **normal ishlayveradi** (TZ 19-band) — faqat OTA'ga
chiqmaydi.

### Beds24 → PMS yo'nalishi

```
Webhook keldi, externalRoomTypeId=99999 uchun mapping yo'q
   ↓
Bron AVTOMATIK YARATILMAYDI
   ↓
WebhookEvent.status = NEEDS_MANUAL_ACTION
   ↓
rawPayload TO'LIQ saqlanadi — ma'lumot yo'qolmaydi
   ↓
Admin'ga WebSocket + Admin panelda ogohlantirish
   ↓
Admin mapping'ni to'g'irlaydi → "Qayta ishlash" tugmasi
   ↓
Event qayta ishlanadi, bron yaratiladi
```

**Ma'lumot hech qachon yo'qolmaydi** — bu eng muhim nuqta. Beds24'dan
kelgan bron real mehmon, uni yo'qotib bo'lmaydi.

---

## 5. Beds24'dan kelgan bron qaysi xonaga tushadi (mijoz qarori Q3)

Mijoz javobi: **avtomatik bo'lishi kerak** — "Beds24 hammasini hal
qilgan bo'ladi, chunki Beds24 avtomatik bronlarni qabul qiladi va
Shaxmatkada ko'rinishi kerak."

Ya'ni admin aralashuvi **talab qilinmaydi**. Algoritm:

```ts
function assignRoom(externalRoomTypeId, checkIn, checkOut, externalUnitId?) {
  // 1) Agar Beds24 aniq unit yuborgan bo'lsa va u mapping qilingan bo'lsa —
  //    aynan o'sha xona ishlatiladi (eng aniq holat)
  if (externalUnitId) {
    const m = findMapping({ externalUnitId });
    if (m?.roomId && isFree(m.roomId, checkIn, checkOut)) return m.roomId;
    // band bo'lsa — pastga tushadi, lekin SyncLog'ga ogohlantirish yoziladi
  }

  // 2) Room type mapping orqali bo'sh xona tanlanadi
  const mapping = findMapping({ externalRoomTypeId });
  if (!mapping) return null;          // §4 — bron yaratilmaydi

  const candidates = rooms
    .filter(r => r.roomTypeId === mapping.roomTypeId && r.isActive)
    .filter(r => r.status !== "OUT_OF_ORDER" && r.status !== "OUT_OF_SERVICE")
    .filter(r => isFree(r.id, checkIn, checkOut))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

  return candidates[0]?.id ?? null;
}
```

### Bo'sh xona topilmasa

Bu **overbooking signali** — Beds24 bizda bo'lmagan xonani sotgan:

```
candidates bo'sh
   ↓
Bron baribir DB'ga yoziladi:
   - Eng mos turdagi xonaga vaqtincha biriktiriladi
   - VA needsAttention = true belgisi qo'yiladi
   ↓
Admin'ga DARHOL ogohlantirish (WebSocket + Admin panel)
   ↓
Admin qo'lda hal qiladi: boshqa xona, upgrade, yoki OTA bilan bog'lanish
```

**Nega rad etilmaydi:** bu real mehmon, Booking.com'da allaqachon
tasdiqlangan. Rad etish OTA qoidalariga zid va jarima keltiradi.
Bronni ko'rsatib, admin'ga qaror qoldirish to'g'ri.

**Diqqat:** bu holatda `reservation_no_overlap` constraint ishga
tushishi mumkin. Shuning uchun bunday bron uchun maxsus yo'l:
constraint xatosi ushlangach, bron `NEEDS_MANUAL_ACTION` sifatida
`WebhookEvent` da saqlanadi va Shaxmatkada alohida "biriktirilmagan
bronlar" ro'yxatida ko'rinadi (API orqali, yangi UI elementi emas).

---

## 6. Validatsiya qoidalari

| Qoida | Constraint |
|---|---|
| Bitta `externalRoomTypeId` + `externalUnitId` juftligi → faqat bitta PMS obyekti | `@@unique([channelId, externalRoomTypeId, externalUnitId])` |
| Bitta PMS xonasi bitta kanalda faqat bir marta | `@@unique([channelId, roomId])` |
| Mapping o'chirilishidan oldin faol bronlar tekshiriladi | dastur mantig'ida, ogohlantirish |
| `RoomType` o'chirilishidan oldin mapping tekshiriladi | foreign key |

**Mapping o'chirilishi.** Agar shu mapping bo'yicha faol
(`CONFIRMED` / `CHECKED_IN` / `PENDING_PAYMENT`) bronlar bo'lsa —
ogohlantirish ko'rsatiladi:

```
⚠ Bu mapping bo'yicha 3 ta faol bron bor.
  O'chirilsa, ular Beds24 bilan sinxronlanmay qoladi.
  [Bekor qilish]  [Baribir o'chirish]
```

O'chirish `isActive = false` orqali (soft delete) — tarixiy SyncLog
yozuvlari o'z ma'nosini yo'qotmasligi uchun.

---

## 7. Mapping to'liqligini tekshirish

FAZA 5 tayyorlik mezoni va keyinchalik doimiy nazorat uchun:

```
GET /api/admin/mapping/health
```

```jsonc
{
  "isComplete": false,
  "roomTypes": [
    { "id": "standard", "rooms": 6, "mapped": true,  "externalRoomTypeId": "12345" },
    { "id": "double",   "rooms": 4, "mapped": true,  "externalRoomTypeId": "12346" },
    { "id": "deluxe",   "rooms": 2, "mapped": false, "warning": "mapping yo'q — OTA'da ko'rinmaydi" }
  ],
  "unmappedRoomCount": 2,
  "orphanMappings": []   // Beds24'da bor, PMS'da yo'q
}
```

Bu endpoint Admin panelda ogohlantirish ko'rsatish uchun ham,
FAZA 5 ni tugatilgan deb hisoblash uchun ham ishlatiladi.

---

## Bu faylga tayanadi

Mapping qoidalari o'zgarsa — quyidagilar tekshirilishi shart:

| Fayl | Nimaga tayanadi |
|---|---|
| [04 §4](04-WEBHOOK-HANDLER.md) | Kelgan bron uchun xona tanlash |
| [07 §4](07-AVAILABILITY-VA-RATES-SYNC.md) | Availability yuborishdan oldin mapping tekshiruvi |
| [12 §3](12-PMS-DAN-BEDS24-GA-SYNC.md) | `resolveMapping()` — bron yuborish |
| [13 §3](13-WEBSITE-INTEGRATSIYA.md) | Website bronida xona tanlash (bir xil algoritm) |
| [11 FAZA 5](11-BOSQICHLAR-ROADMAP.md) | Mapping ekrani va tayyorlik mezoni |
