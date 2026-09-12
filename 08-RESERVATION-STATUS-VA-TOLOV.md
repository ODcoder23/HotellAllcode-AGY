# 08 — Reservation status mapping va to'lov

> **Manba:** `TZ-ASL.md` **8-band** (6 ta status qo'llab-quvvatlansin),
> **14-band** (to'lov hisob-kitobi), **1-band** (check-in/check-out,
> to'lov ma'lumotlari Beds24'dan keladi).
> Mijoz qarorlari: **Q5** (ikki yangi status Shaxmatkaga qo'shiladi),
> **Q7** (check-in/check-out Beds24 bilan sinxronlanadi).

---

## 1. TZ 8-band: oltita status to'liq qo'llab-quvvatlanadi

```
PENDING_PAYMENT
CONFIRMED
CHECKED_IN
CHECKED_OUT
CANCELLED
NO_SHOW
```

TZ "qo'llab-quvvatlansin" deydi — ya'ni ular DB'da saqlanibgina
qolmay, **foydalanuvchiga ko'rinishi va ishlashi** kerak.

### Mijoz qarori: Variant B qabul qilindi

Mavjud Shaxmatkada 4 ta status bor (`RES_STATUS` obyektida
`confirmed`, `checked_in`, `checked_out`, `cancelled`).
`pending_payment` va `no_show` yo'q.

Mijoz tasdiqladi: **"2 ta statusni qo'shsa bo'ladi, bu yaxshi."**

Shuning uchun `index (7).html` faylidagi `RES_STATUS` obyektiga
**ikki qator** qo'shiladi:

```js
const RES_STATUS = {
  pending_payment: { label: "To'lov kutilmoqda", chip: "bg-violet-100 text-violet-800" },
  confirmed:       { label: "Tasdiqlangan",      chip: "bg-amber-100 text-amber-800" },
  checked_in:      { label: "Kirgan",            chip: "bg-blue-100 text-blue-800" },
  checked_out:     { label: "Chiqqan",           chip: "bg-gray-100 text-gray-600" },
  cancelled:       { label: "Bekor qilingan",    chip: "bg-red-100 text-red-700" },
  no_show:         { label: "Kelmadi",           chip: "bg-stone-200 text-stone-700" },
};
```

**Bu — yagona o'zgartirish.** Sabab: `RES_STATUS` obyekti butun
frontendda avtomatik ishlatiladi — filtr ro'yxati
(`Object.entries(RES_STATUS).map(...)`), `ResStatusBadge` komponenti,
detail modal. Ikki qator qo'shilishi bilan yangi statuslar hamma
joyda o'z-o'zidan ishlaydi. Komponentlar, UI, mantiq — **tegilmaydi**.

### Nega "tarjima qilish" (Variant A) rad etildi

Muqobil yechim `PENDING_PAYMENT` ni frontendga `confirmed` deb
ko'rsatish edi. Bu rad etildi, chunki:

- Xodim **to'lanmagan bronni tasdiqlangan deb ko'radi** — bu biznes
  xatosi, mehmon kelganda tushunmovchilik chiqadi
- TZ 8-bandi "qo'llab-quvvatlansin" deydi; yashirish qo'llab-quvvatlash
  emas
- Website'dan kelgan har bron `PENDING_PAYMENT` bo'ladi (`13`-fayl §5) —
  ya'ni bu kamdan-kam holat emas, balki kundalik oqim

### `roomStatusForReservation` ham yangilanadi

Frontenddagi mavjud funksiya ikki yangi statusni bilishi kerak:

```js
function roomStatusForReservation(res) {
  if (res.status === "checked_in") return "occupied";
  if (res.status === "checked_out") return "dirty";
  if (res.status === "confirmed") return "reserved";
  if (res.status === "pending_payment") return "reserved";  // yangi — xona band
  if (res.status === "no_show") return "available";         // yangi — xona bo'shaydi
  return null;
}
```

`pending_payment` → `reserved`: to'lanmagan bron ham xonani band
qiladi (`13`-fayl §5). `no_show` → `available`: mehmon kelmadi,
xona bo'shaydi (§4).

---

## 2. Beds24 ↔ PMS status mapping

Mapping **bitta markaziy faylda** — har joyga tarqatilmaydi:

```ts
// services/beds24/statusMap.ts

export function toPmsStatus(b: Beds24Booking): ReservationStatus {
  if (b.status === "cancelled")  return "CANCELLED";
  if (b.status === "black")      return "NO_SHOW";      // tasdiqlanadi (§3)
  if (b.status === "request")    return "PENDING_PAYMENT";
  if (b.status === "new")        return isPaid(b) ? "CONFIRMED" : "PENDING_PAYMENT";
  if (b.status === "confirmed") {
    if (b.subStatus === "departed") return "CHECKED_OUT";
    if (b.subStatus === "arrived")  return "CHECKED_IN";
    return "CONFIRMED";
  }
  return "CONFIRMED";
}

export function toBeds24Status(s: ReservationStatus) {
  switch (s) {
    case "PENDING_PAYMENT": return { status: "request" };
    case "CONFIRMED":       return { status: "confirmed" };
    case "CHECKED_IN":      return { status: "confirmed", subStatus: "arrived" };
    case "CHECKED_OUT":     return { status: "confirmed", subStatus: "departed" };
    case "CANCELLED":       return { status: "cancelled" };
    case "NO_SHOW":         return { status: "black" };
  }
}
```

| Beds24 | PMS | Izoh |
|---|---|---|
| `request` | `PENDING_PAYMENT` | to'lov kutilmoqda |
| `new` (to'lanmagan) | `PENDING_PAYMENT` | to'lov holatiga qarab |
| `new` (to'langan) | `CONFIRMED` | |
| `confirmed` | `CONFIRMED` | |
| `confirmed` + arrived | `CHECKED_IN` | mijoz qarori Q7 |
| `confirmed` + departed | `CHECKED_OUT` | mijoz qarori Q7 |
| `cancelled` | `CANCELLED` | |
| `black` | `NO_SHOW` | tasdiqlanishi kerak |

---

## 3. FAZA 10 da real javob bilan tasdiqlash

Yuqoridagi jadval Beds24 hujjatlariga asoslangan, lekin aniq qiymatlar
hisob sozlamasiga qarab farq qilishi mumkin (`black` statusi,
`subStatus` maydonining nomi).

Shuning uchun **FAZA 10** da:

```
1. GET /bookings — real sandbox ma'lumoti olinadi (mock EMAS)
2. Har status qiymati qayd qilinadi
3. statusMap.ts shunga moslanadi
4. Natija hujjatga qaytariladi
```

Agar Beds24 biror statusni qo'llab-quvvatlamasa — eng yaqin
muqobilga map qilinadi va `SyncLog` ga izoh yoziladi. PMS tomonidagi
status esa **o'zgarmaydi** — TZ 8-bandi PMS'da 6 ta statusni talab
qiladi, Beds24 cheklovi bunga ta'sir qilmaydi.

---

## 4. `NO_SHOW` biznes mantiqi

```
Check-in kuni o'tdi, mehmon kelmadi
        ↓
Tizim AVTOMATIK bekor qilmaydi
        ↓
Admin qo'lda "Kelmadi" deb belgilaydi
        ↓
Reservation.status = NO_SHOW
Room.status = AVAILABLE (bo'shaydi)
availability-sync → Beds24 → OTA
        ↓
Reservation tarixda QOLADI (statistika uchun)
```

**Nega avtomatik emas:** mehmon kechikishi mumkin (reys kechikdi,
kech keldi). Avtomatik `NO_SHOW` real mehmonni yo'qotish xavfini
tug'diradi. Qaror — admin'da.

Tizim faqat **eslatma** beradi: check-in kuni 18:00 dan keyin hali
`CONFIRMED` holatidagi bronlar Admin panelda ajratib ko'rsatiladi.

---

## 5. Check-in / check-out (mijoz qarori Q7)

Mijoz tasdiqladi: **Beds24 qo'llab-quvvatlaydi, muammo yo'q.**

```
Shaxmatkada "Check-in" bosildi
        ↓
Reservation.status = CHECKED_IN
Reservation.checkedInAt = now()      ← TZ 1-band: check-in vaqti saqlanadi
Room.status = OCCUPIED
        ↓
reservation-sync job → Beds24 (12-fayl §6)
```

```
"Check-out" bosildi
        ↓
Reservation.status = CHECKED_OUT
Reservation.checkedOutAt = now()
Room.status = DIRTY
        ↓
reservation-sync job → Beds24
availability-sync (agar erta chiqsa — qolgan kunlar bo'shaydi)
```

Teskari yo'nalish ham ishlaydi: Beds24'da check-in qilinsa,
webhook orqali PMS'ga keladi va Shaxmatkada ko'rinadi (TZ 1-band
"check-in, check-out" ma'lumotini olishni talab qiladi).

---

## 6. To'lov hisob-kitobi (TZ 14-band)

```
totalPrice      = pricePerNight × nights + Σ charges.amount
paidAmount      = Σ payments.amount          (reversal = manfiy summa)
remainingAmount = max(totalPrice − paidAmount, 0)
```

Bu formula Shaxmatka frontendidagi mantiq bilan **aynan bir xil** —
`CheckoutModal`, `PaymentModal` va `PayPill` shu tarzda hisoblaydi:

```js
const chargesTotal = (res.charges || []).reduce((s, c) => s + c.amount, 0);
const total = res.pricePerNight * nights + chargesTotal;
const paid = (res.payments || []).reduce((s, p) => s + p.amount, 0);
```

Backend API javobida `totalPrice`, `paidAmount`, `remainingAmount`
maydonlarini **tayyor holda** qaytaradi. Frontend hozir o'zi
hisoblaydi va shunday qolaveradi — ikkalasi bir xil natija beradi.
Yangi maydonlar qo'shimcha sifatida boradi, frontend ularni
e'tiborsiz qoldiradi.

**`Decimal` → `number`.** Prisma `Decimal` obyekt qaytaradi, frontend
esa son kutadi (`reduce` ustida arifmetika). Konvertatsiya API
serializatsiya qatlamida, bitta markaziy joyda.

---

## 7. Beds24'dan kelgan to'lov (TZ 1, 14-band)

```
payment.updated webhook
        ↓
Reservation topiladi (externalReservationId orqali)
        ↓
Payment yaratiladi:
  amount, method, paymentDate
  externalPaymentId = Beds24 payment id
  channelId = beds24
        ↓
@@unique([channelId, externalPaymentId]) — bir to'lov ikki marta yozilmaydi
        ↓
WebSocket: payment.updated → Shaxmatka
        ↓
PayPill avtomatik yangilanadi ("To'liq to'langan" / "Qarz bor")
```

**`PayPill` komponentiga tegilmaydi** — u faqat `paid/total` nisbatiga
qarab ishlaydi, ma'lumot qayerdan kelgani uning uchun ahamiyatsiz.
TZ 14-bandning *"Shaxmatkada To'liq to'langan / Qarz bor holati
ko'rinsin"* talabi shu bilan bajariladi.

### OTA to'lovi haqida muhim nuance

Booking.com'da mehmon to'lagan pul odatda **mehmonxonaga darhol
tushmaydi** — OTA uni keyinroq o'tkazadi. Shuning uchun:

```
Payment.method = "Onlayn (Booking.com)"
Payment.channelId = beds24
```

Bu to'lov `paidAmount` ga kiradi (mehmon qarzdor emas), lekin
`method` orqali ajratib ko'rsatiladi. Kassa hisoboti uchun kelajakda
`channelId IS NULL` filtri bilan faqat naqd/karta to'lovlarni ajratish
mumkin — hozircha kerak emas, TZ buni talab qilmaydi.

---

## 8. Valyuta

`Reservation.currency` maydoni bor (TZ 1-band "valyuta" ni talab
qiladi), default `USD`. Shaxmatka `money()` funksiyasi hamma joyda
`$` belgisini ishlatadi.

Beds24'dan boshqa valyutada bron kelsa:

```
Kelgan valyuta SAQLANADI (Reservation.currency = "EUR")
Konvertatsiya QILINMAYDI — kurs manbai TZ'da yo'q, taxmin xavfli
API javobida currency maydoni ham boradi
```

Frontend hozir `$` ko'rsatadi — boshqa valyutali bron kamdan-kam
bo'lgani uchun bu hozircha muammo emas. Agar ko'p bo'lsa,
`money()` funksiyasiga valyuta parametri qo'shiladi (bir qator).

> ⚠️ Mehmonxona qaysi valyutalarda ishlashi FAZA 10 da aniqlanadi.
