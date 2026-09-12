# 05 — Sync Queue (Redis + BullMQ)

> **Manba:** `TZ-ASL.md` **11-band** (5 ta navbat, retry, SyncLog),
> **6-band** ("har bir o'zgarish queue orqali yuborilsin"),
> **17-band** (Beds24 ishlamasa PMS davom etadi).


**Bu fayl javob beradi:**

- Nechta navbat bor va har biri nima qiladi?
- API xato bersa necha marta qayta urinadi?
- Kredit tugasa nima bo'ladi?
- Beds24 o'chsa foydalanuvchi sezadimi?

---

## 1. Navbatlar (TZ 11-band)

TZ aynan shu beshtasini nomma-nom talab qiladi:

| Navbat | Vazifasi | Trigger | Hujjat |
|---|---|---|---|
| `beds24-reservation-sync` | Bron o'zgarishini Beds24'ga | Shaxmatka/Website'dagi 8 amal | `12` |
| `beds24-availability-sync` | Bandlik o'zgarishini Beds24'ga | Har availability o'zgarishi | `07` |
| `beds24-rate-sync` | Narx o'zgarishini Beds24'ga | `RatePlan` yangilansa | `07` §7 |
| `beds24-webhook` | Kiruvchi webhook'ni qayta ishlash | `POST /api/webhooks/beds24` | `04` |
| `beds24-retry` | Muvaffaqiyatsiz job'larni qayta yuborish | Har qanday job xato bersa | §3 |

### Qo'shimcha repeatable job'lar

TZ boshqa bandlarida talab qilingan, lekin 11-bandda sanalmagan:

| Job | Davri | Vazifasi | TZ bandi |
|---|---|---|---|
| `beds24-poll-bookings` | 15 daqiqa | Webhook fallback | 10-band |
| `beds24-drift-check` | 24 soat | Inventory solishtirish | 20-band |
| `pending-payment-cleanup` | 1 soat | To'lanmagan bronlarni bekor qilish | 3-band |

---

## 2. Job dizayni — uchta printsip

### a) Idempotentlik

Har job payload'ida **tabiiy kalit** bo'ladi (`reservationId`,
`roomTypeId + sana oralig'i`). Job ikki marta bajarilsa ham natija
bir xil.

```
✅ To'g'ri:  "narxni 35 qilib qo'y", "3 ta bo'sh deb belgila"
❌ Noto'g'ri: "narxga +10 qo'sh", "bittaga kamaytir"
```

Ikkinchi shakl retry bilan birga ishlaganda ma'lumotni buzadi.

### b) DB'dan qayta o'qish

Worker payload'dagi eski nusxaga emas, **DB'dagi joriy holatga**
qarab ish ko'radi:

```ts
async function processReservationSync(job) {
  // Payload'dagi ma'lumot ESKIRGAN bo'lishi mumkin
  const res = await prisma.reservation.findUnique({
    where: { id: job.data.reservationId },
    include: { guest: true, room: true },
  });
  if (!res) return;              // o'chirilgan — job bekor
  await beds24.pushReservation(res);   // joriy holat yuboriladi
}
```

Natija: job navbatda turganda bron yana o'zgarsa — worker eng oxirgi
holatni yuboradi, eskisini emas.

### c) Debounce va batch

Bitta xonaning bir necha kunlik availability'si ketma-ket o'zgarsa,
har birini alohida job qilish kredit isrof qiladi ([03 §3](03-BEDS24-API-INTEGRATSIYA.md):
100 kredit / 5 daqiqa):

```
Bron yaratildi: 15–20 sentabr (6 kun)
        ↓
6 ta alohida job EMAS
        ↓
2–3 soniyalik oynada yig'iladi → BITTA job
        ↓
POST /inventory/rooms/calendar
  [{ roomId, calendar: [{ from: "2026-09-15", to: "2026-09-20", numAvail: 5 }] }]
```

BullMQ'da bu `jobId` ni takrorlash orqali:

```ts
await availabilityQueue.add("sync", payload, {
  jobId: `avail-${roomTypeId}-${from}`,   // bir xil id = bitta job
  delay: 3000,
});
```

---

## 3. Rate-limit-aware ishlov

Beds24 cheklovi: **5 daqiqalik aylanma oyna, ~100 kredit**
([03 §3](03-BEDS24-API-INTEGRATSIYA.md)). Har javobda:

```
x-five-min-limit-remaining
x-five-min-limit-resets-in
x-request-cost
```

`client.ts` bu qiymatlarni Redis'da saqlaydi. Har job bajarilishidan
oldin tekshiriladi:

```ts
const remaining = await redis.get("beds24:credits:remaining");
if (Number(remaining) < SAFETY_THRESHOLD) {   // masalan 10
  const resetsIn = await redis.get("beds24:credits:resetsIn");
  throw new DelayedError();    // BullMQ: kechiktir, XATO deb sanama
}
```

**Muhim:** kredit tugashi **xato emas** — job kechiktiriladi va
`attempts` hisobiga kirmaydi. Aks holda normal yuklamada job'lar
bekorga "failed" bo'lib qolardi.

Global concurrency ham cheklanadi (masalan 2 worker) — bir vaqtda
o'nlab so'rov yuborib kreditni bir zumda tugatmaslik uchun.

---

## 4. Retry siyosati (TZ 11-band)

TZ: *"API xato bersa: retry → retry → retry bo'lsin."*

```ts
const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },  // 5s, 10s, 20s, 40s, 80s
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: false,          // xatolar saqlanadi — tahlil uchun
};
```

### Qaysi xato retry qilinadi, qaysi biri yo'q

| Xato | Retry? | Sabab |
|---|---|---|
| Tarmoq xatosi, timeout | ✅ | vaqtinchalik |
| `5xx` server xatosi | ✅ | Beds24 tomonida muammo |
| `429` rate limit | ✅ | kechiktiriladi (§3) |
| `401` token eskirgan | ✅ | token yangilanib, qayta urinadi |
| `400` noto'g'ri payload | ❌ | qayta yuborish foydasiz |
| Mapping topilmadi | ❌ | o'z-o'zidan paydo bo'lmaydi |

Retry qilinmaydigan xatolar darhol `FAILED` bo'ladi va `SyncLog` ga
yoziladi — 5 marta bekorga urinilmaydi.

### 5 urinishdan keyin

```
Job "dead letter" holatiga o'tadi
SyncLog.status = FAILED (barcha urinishlar bilan)
Reservation.syncStatus = FAILED
Admin panelda ko'rinadi (API orqali, yangi UI komponenti emas)
rawPayload saqlanib turadi — qo'lda qayta yuborish mumkin
```

---

## 5. Xato holatida PMS ishini to'xtatmaslik (TZ 17-band)

TZ: *"Beds24 vaqtincha ishlamasa — PMS ishlashda davom etishi kerak.
Bron database'ga saqlansin. Queue syncni kutib tursin. Beds24 qayta
ishlaganda avtomatik yuborilsin."*

```
Foydalanuvchi Shaxmatkada bron yaratadi
        ↓
PMS Backend: DB transaction  (millisekundlar)     ← ASOSIY AMAL
        ↓
Queue'ga job qo'shiladi  (fire-and-forget)
        ↓
Frontendga 200 OK DARHOL                          ← foydalanuvchi kutmaydi
        ↓
(fonda) Worker Beds24'ga yuboradi → retry → retry
```

**Beds24 butunlay o'chib qolsa:**

- Bronlar DB'da to'planadi, `syncStatus = PENDING`
- PMS, Shaxmatka, Website — to'liq ishlaydi
- Overbooking xavfi yo'q (himoya PMS ichida)
- Beds24 qaytganda navbat o'z-o'zidan bo'shaydi

Bu — TZ 19-bandning ("PMS ichki ishlashi Beds24ga bog'lanib
qolmasin") amaliy ifodasi.

---

## 6. Ketma-ketlik kafolati

Bitta bron ustida ikki o'zgarish tez ketma-ket qilinsa, ular
Beds24'ga to'g'ri tartibda yetishi kerak:

```ts
await reservationQueue.add("sync", payload, {
  group: { id: `reservation-${reservationId}` },   // bir bron = bir oqim
});
```

Ikkinchi himoya — §2b dagi "DB'dan qayta o'qish": tartib buzilsa ham
yakuniy natija to'g'ri bo'ladi, chunki har worker eng oxirgi holatni
yuboradi.

---

## 7. Har job `SyncLog` ga yoziladi (TZ 11, 16-band)

TZ: *"Errorlar SyncLog'ga yozilsin."* Amalda **barcha** urinishlar
yoziladi — muvaffaqiyatlilari ham, chunki 16-band to'liq audit
talab qiladi:

```ts
await syncLog.create({
  channelId, action: "push_availability",
  direction: "PMS_TO_CHANNEL",
  request: sanitizeForLog(requestBody),     // [10 §2](10-SECURITY-VA-SYNCLOG.md)
  response: sanitizeForLog(responseBody),
  status: "SUCCESS" | "FAILED" | "RETRYING" | "SKIPPED",
  attempt: job.attemptsMade + 1,
  durationMs, errorMessage,
});
```

`SKIPPED` holati — masalan source-of-truth boshqa tomonda bo'lgani
uchun narx yuborilmadi ([07 §7](07-AVAILABILITY-VA-RATES-SYNC.md)). Bu xato emas, lekin ko'rinishi
kerak.

---

## 8. Monitoring

```ts
const counts = await queue.getJobCounts();
// { waiting, active, completed, failed, delayed }
```

```
GET /api/admin/queues/status
```

Ko'rsatadi: har navbat uchun job'lar soni, oxirgi muvaffaqiyatli sync
vaqti, qolgan kredit, `FAILED` job'lar ro'yxati.

Backend ichidagi `/admin/sync-log` sahifasida ko'rsatiladi
([06 §3](06-XONA-MAPPING.md) bilan bir xil yondashuv — mavjud Admin
Panel kodiga tegilmaydi).

## Amalga oshirilgan holat (FAZA 14 — `beds24-retry`)

TZ 11-band beshta navbatni sanaydi. To'rttasi — ish navbatlari
(webhook, reservation, availability, rate). Beshinchisi,
`beds24-retry`, retry MEXANIZMI emas: retry allaqachon har
navbatning o'zida ishlaydi (`attempts: 5`, exponential backoff).

Shuning uchun u **"o'lik xat" (dead letter)** navbati sifatida
amalga oshirildi — `backend/src/queues/deadLetter.ts`:

```
5 urinishdan keyin ham bo'lmagan job (yoki UnrecoverableError)
        ↓
beds24-retry navbatiga tushadi: nima, qachon, nega yiqildi
        ↓
Admin GET /api/admin/dead-letters da ko'radi
        ↓
Sabab tuzatilgach: POST /api/admin/dead-letters/requeue
        ↓
Job asl navbatiga qaytadi
```

**Nega kerak:** `failed` job BullMQ ichida qoladi va uni faqat
Redis'ga kirib ko'rish mumkin. Admin panelda ko'rinmaydi, ya'ni
yo'qolgan sync jim o'tib ketadi. TZ 11-band "Errorlar SyncLog'ga
yozilsin" deydi — bu uning amaliy davomi: xato yozilgan, endi u
bilan nima qilish kerakligi ham bor.

**`UnrecoverableError` ham tushadi.** Bunday xatoda `attemptsMade`
maksimumga yetmaydi (BullMQ qayta urinmaydi), shuning uchun faqat
urinishlar sonini solishtirish yetarli emas — `isFinal` bayrog'i
chaqiruvchidan keladi.

**Tekshirilgan:** mapping o'chirilgan holatda bron yaratildi —
ikkala job (reservation + availability) o'lik xatga tushdi, sabab
ko'rindi. Mapping va ulanish tiklangach `requeue` ikkalasini ham
qaytardi, bronlar `synced` bo'ldi.


## Bu faylga tayanadi