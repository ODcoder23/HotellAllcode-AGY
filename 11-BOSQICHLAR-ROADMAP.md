# 11 — Bosqichlar (Roadmap)

> **Manba:** `TZ-ASL.md` — barcha 20 band. Har faza oxirida qaysi TZ
> bandi bajarilgani ko'rsatiladi.

**QOIDA:** Har faza alohida, to'liq tugatilgan holda topshiriladi.
Bir fazada ikkinchisining ishini boshlash taqiqlanadi. Har faza
oxirida — *"shu faza tugadi, keyingisiga o'tishga ruxsat bering"*
tarzida to'xtaladi.


**Bu fayl javob beradi:**

- Ish qanday tartibda bajariladi?
- Har faza qachon tugagan hisoblanadi?
- Qaysi TZ bandi qaysi fazada bajariladi?
- Nima uchun Beds24 tekshiruvi boshda?

---

## FAZA 0 — Tayyorgarlik (kod yozilmaydi)

- `TZ-ASL.md` va `[01](01-ARXITEKTURA-VA-QOIDALAR.md)` to'liq o'qiladi.
- Mavjud backend tekshiriladi: Express/Prisma bormi, PostgreSQL/Redis
  ulanishi bormi. Yo'q bo'lsa — skelet tayyorlanadi (Docker Compose:
  api + postgres + redis), biznes-mantiq yozilmaydi.
- Beds24 hisobiga kirish huquqi yo'q — mock server bilan ishlaymiz
  (FAZA 0.5). Tizim to'liq ishlaydigan holatda topshiriladi.
- Mavjud Admin Panel va Website kodiga **kirish yo'q** — ular bilan
  ishlash scope'dan tashqarida. Bizda faqat Shaxmatka
  (`index (7).html`) va TZ bor.

**Mezon:** `docker compose up` ishlaydi, `/health` javob beradi.

---

## FAZA 0.5 — Mock Beds24 server (kod yoziladi)

> **Ish chegarasi.** Bizda Beds24 hisobiga ulanish huquqi **yo'q**, lekin
> tizim **to'liq ishlaydigan holatda** topshiriladi. Beds24 moduli ham
> biz tomonidan yoziladi va mock server bilan uchdan-uchgacha test
> qilinadi. Dasturchi faqat credentials qo'yadi — kod yozmaydi.

### Kim nima qiladi

| Biz yozamiz | Dasturchi qiladi |
|---|---|
| Butun backend + DB + API | `.env` ga Beds24 credentials qo'yadi |
| `services/beds24/*` (auth, client, bookings, calendar) | Beds24 panelida webhook URL kiritadi |
| Webhook handler + BullMQ worker'lar | Mapping ekranida turlarni bog'laydi (3 klik) |
| Mock Beds24 server + integratsiya testlari | Deploy qiladi |
| WebSocket, Public API | **Boshqa hech narsa** |

### Mock server

`mock-beds24/` — kichik Express ilova, Beds24 API v2 ni taqlid qiladi:

```
mock-beds24/
  server.ts              Express, port 4000
  routes/
    authentication.ts    /authentication/setup, /token
    properties.ts        GET /properties
    bookings.ts          GET/POST /bookings
    calendar.ts          GET/POST /inventory/rooms/calendar
  fixtures/              namunaviy javoblar (room type, booking)
  scenarios.ts           xato holatlari
  webhook-sender.ts      PMS'ga webhook yuboradi
```

**Nimani simulyatsiya qiladi:**

| Holat | Qanday |
|---|---|
| Normal javob | Fixture'dan JSON |
| Rate limit | `x-five-min-limit-remaining` kamayadi, 0 da `429` |
| Server xatosi | `?scenario=500` bilan majburan `500` |
| Timeout | `?scenario=timeout` bilan 30s kutadi |
| Webhook | Bron yaratilganda PMS endpoint'iga POST |
| Duplicate webhook | Bir xil payload ikki marta yuboradi |

**Nega kerak:** usiz "tizim ishlaydi" degan gap asossiz bo'ladi. Mock
bilan retry, rate-limit kechiktirish, echo loop himoyasi, duplicate
dedup — hammasi real sinovdan o'tadi.

### Almashtirish

```
Test:       BEDS24_BASE_URL=http://localhost:4000
Production: BEDS24_BASE_URL=https://api.beds24.com/v2
```

Kod ikkalasida ham **bir xil** — `client.ts` faqat `BEDS24_BASE_URL`
ni o'qiydi. Dasturchi bitta o'zgaruvchini almashtiradi.

### Aniqlanishi kerak bo'lgan 6 fakt

Mock server hujjatdagi **taxminlar** asosida yoziladi. Dasturchi real
hisobga ulangach quyidagilarni tasdiqlaydi va farq bo'lsa xabar beradi:

| № | Taxmin | Agar farq qilsa |
|---|---|---|
| 1 | Xonalar room type darajasida | [06 §2](06-XONA-MAPPING.md) — unit mapping yoqiladi (kod tayyor) |
| 2 | 3 room type (standard/double/deluxe) | Mapping ekranida ko'rinadi, kod o'zgarmaydi |
| 3 | Har turda 6/4/2 xona | [07 §2](07-AVAILABILITY-VA-RATES-SYNC.md) — `Availability` qayta hisoblanadi |
| 4 | Webhook signature beradi | [04 §9](04-WEBHOOK-HANDLER.md) — IP whitelist rejimiga o'tadi |
| 5 | 100 kredit / 5 daqiqa | [05 §3](05-SYNC-QUEUE-BULLMQ.md) — chegara `.env` dan o'qiladi |
| 6 | Test property bor | Yo'q bo'lsa — real hisobda ehtiyot bilan |

Har biri uchun kod **ikkala holatni ham qo'llab-quvvatlaydi** —
konfiguratsiya orqali. Ya'ni farq chiqsa kod qayta yozilmaydi.

**Mezon:** mock server ishga tushadi, `GET /properties` javob beradi,
webhook yuboradi; `BEDS24_BASE_URL` almashtirilganda kod o'zgarmaydi.

**TZ:** 12-band (channel abstraksiyasi) ✅

---

## FAZA 1 — Database (`02`)

- Prisma schema to'liq yoziladi va migratsiya qilinadi (TZ 13-band:
  12 ta majburiy jadval + qo'shimchalar).
- **Raw SQL migratsiya:** `btree_gist` + `reservation_no_overlap`
  exclusion constraint ([02 §2](02-DATABASE-SXEMA.md)). Buni Prisma o'zi yarata
  olmaydi — qo'lda yoziladi.
- Seed: 12 xona (`Room.id` = xona raqami), 3 room type, test bronlar.

**Mezon:** barcha jadvallar bor; seed'da 12 xona (standard 6,
double 4, deluxe 2); constraint mavjudligi `\d Reservation` bilan
tasdiqlangan.

**TZ:** 13-band ✅

---

## FAZA 2A — Ichki REST API (CRUD)

- Shaxmatka funksiyalariga mos endpoint'lar:
  `GET/POST /rooms`, `GET/POST/PATCH /reservations`,
  `POST /reservations/:id/payments`, `/charges`,
  `/check-in`, `/check-out`, `/cancel`, `/change-room`, `/change-dates`.
- API javob formati [02 §3](02-DATABASE-SXEMA.md) jadvaliga qat'iy mos
  (`guestName` flatten, `Decimal` → `number`, sana `"YYYY-MM-DD"`).
- Shaxmatka **hali ulanmaydi** — Postman/curl bilan tekshiriladi.

**Mezon:** barcha amallar API orqali ishlaydi, javob formati
frontend kutgan shaklda.

**TZ:** 13-band ✅

---

## FAZA 2B — Overbooking himoyasi (TZ 3-band)

Alohida faza — chunki bu TZ'ning eng muhim talabi va jiddiy
test talab qiladi.

- Transaction + `Serializable` isolation ([07 §5](07-AVAILABILITY-VA-RATES-SYNC.md), 2-qatlam).
- Constraint xatosini (`23P01`) tutib, tushunarli xabarga aylantirish.
- `Availability` agregatsiya funksiyasi ([07 §2](07-AVAILABILITY-VA-RATES-SYNC.md)).
- **Parallel test:** 20 ta bir vaqtdagi so'rov bitta xonaga →
  faqat bittasi muvaffaqiyatli bo'lishi sinaladi.

**Mezon:** parallel test o'tadi; hech qanday sharoitda ikkita
qoplanuvchi bron yaratilmaydi.

**TZ:** 3-band ✅

---

## FAZA 3 — Shaxmatka'ni backendga ulash

- `useState(buildRooms())` / `useState(buildSeedReservations)`
  o'rniga backend API'dan `fetch`.
- UI komponentlari, ko'rinish, mantiq — **o'zgarmaydi**.
- `RES_STATUS` ga ikki yangi status qo'shiladi ([08 §1](08-RESERVATION-STATUS-VA-TOLOV.md),
  mijoz qarori Q5) va `roomStatusForReservation` yangilanadi.

**Mezon:** Shaxmatka brauzerda backend ma'lumotlarini ko'rsatadi;
bron yaratish DB'ga yoziladi; 6 ta status ham to'g'ri ko'rinadi.

**TZ:** 8-band ✅

---

## FAZA 4 — Beds24 auth va client (`03`)

- `services/beds24/auth.ts` — token olish, cache, avtomatik yangilash.
- `services/beds24/client.ts` — rate-limit headerlarini o'qiydi,
  kredit tugasa keyingi so'rovni kechiktiradi.
- `ChannelConnection` yaratiladi — invite code CLI skript orqali
  kiritiladi (`npm run beds24:connect`). Dasturchi shu skriptni
  real code bilan ishga tushiradi.
- `MockAdapter` va `Beds24Adapter` — ikkalasi ham `ChannelAdapter`
  interfeysini bajaradi ([01 §4](01-ARXITEKTURA-VA-QOIDALAR.md)).
- Unit-level mapping **konfiguratsiya orqali** yoqiladi/o'chiriladi —
  Beds24 qaysi rejimda bo'lishidan qat'i nazar kod ishlaydi
  ([06 §2](06-XONA-MAPPING.md)).

**Mezon:** mock server'dan property ro'yxati olinadi; token avtomatik
yangilanadi; kredit hisobi loglanadi; `429` qaytganda job kechiktiriladi
(xato sifatida sanalmaydi).

**TZ:** 18-band (credentials) ✅

---

## FAZA 5 — Xona mapping (`06`)

- `ChannelMapping` CRUD API.
- **Backend ichida alohida admin sahifasi** (`/admin/mapping`) —
  oddiy HTML + fetch. Mavjud Admin Panel kodiga tegilmaydi
  (unga kirish huquqi yo'q).
- `GET /api/admin/mapping/health` endpoint.
- Mapping yo'qligida sync rad etilishi test qilinadi.

**Mezon:** uchala room type ham Beds24'dagi turga bog'langan;
`mapping/health` → `isComplete: true`.

**TZ:** 5-band ✅

---

## FAZA 6 — Webhook qabul qilish (`04`)

- `POST /api/webhooks/beds24` — validate, saqlash, dedup, queue.
- Beds24 panelida webhook URL sozlanadi (mijoz bilan birga).
- Signature bormi — shu yerda aniqlanadi ([04 §9](04-WEBHOOK-HANDLER.md)).
- Real webhook qabul qilinib, **aniq event nomlari qayd etiladi**.
- Duplicate test: bir xil webhook ikki marta → ikkinchisi
  `IGNORED_DUPLICATE`.

**Mezon:** Beds24'da test bron yaratilganda `WebhookEvent` DB'da
paydo bo'ladi; takroriy webhook duplicate deb belgilanadi.

**TZ:** 10-band (qisman), 9-band (1-qatlam) ✅

---

## FAZA 7 — Queue va webhook → Reservation (`04`, `05`)

- BullMQ barcha navbatlari (TZ 11-band: 5 ta navbat).
- Webhook worker: `WebhookEvent` → `Reservation`.
- **Avtomatik xona biriktirish** ([06 §5](06-XONA-MAPPING.md), mijoz qarori Q3).
- Mapping yo'q / bo'sh xona yo'q holatlari test qilinadi.
- Retry/backoff sinaladi (Beds24'ni vaqtincha bloklab).

**Mezon:** Beds24'da yaratilgan test bron avtomatik ravishda
to'g'ri xonaga biriktirilgan `Reservation` sifatida paydo bo'ladi.

**TZ:** 1, 4, 9, 10, 11, 17-band ✅

---

## FAZA 8 — Real-time (`09`)

- WebSocket server + Redis pub/sub (ko'p instansiya uchun).
- FAZA 7 worker'i yakunida event yuboradi.
- Shaxmatkaga WebSocket tinglovchi (faqat state yangilash).
- Ulanish uzilsa — REST orqali to'liq qayta yuklash.

**Mezon:** Beds24'da test bron yaratilsa, Shaxmatka ochiq turgan
brauzerda **sahifani yangilamasdan** paydo bo'ladi.

**TZ:** 4, 15-band ✅

---

## FAZA 9 — PMS → Beds24: availability (`07`, `12`)

- `beds24-availability-sync` to'liq yoziladi.
- Agregatsiya: room type bo'yicha son ([07 §2](07-AVAILABILITY-VA-RATES-SYNC.md)).
- Debounce + batch + `syncedCount` solishtiruvi (kredit tejash).
- Barcha trigger'lar ulanadi ([07 §3](07-AVAILABILITY-VA-RATES-SYNC.md)).

**Mezon:** Shaxmatkada xona band qilinganda, mock server'ga
`POST /inventory/rooms/calendar` yetib keladi va `numAvail` to'g'ri
songa kamayadi (6 → 5 → 4 ...). Mock so'rovni qayd qiladi, test uni
tekshiradi.

**TZ:** 6-band ✅

---

## FAZA 10 — PMS → Beds24: bronlar (`12`)

TZ 2-bandining sakkiz amali to'liq.

- `beds24-reservation-sync` worker ([12 §2](12-PMS-DAN-BEDS24-GA-SYNC.md), §3).
- Sakkiz amal ham test qilinadi: yaratish, o'zgartirish, **xona
  almashtirish**, sana, mehmon soni, narx, bekor qilish,
  **check-in/check-out**.
- Xona almashtirishda ikki tur availability'si ([12 §4](12-PMS-DAN-BEDS24-GA-SYNC.md)).
- Echo loop himoyasi tekshiriladi.
- Status mapping `statusMap.ts` da markazlashtiriladi va mock
  fixture'lari bilan test qilinadi. Real qiymatlar farq qilsa —
  faqat shu fayl yangilanadi ([08 §3](08-RESERVATION-STATUS-VA-TOLOV.md)).

**Mezon:** sakkiz amalning har biri mock server'ga yetib keladi va
to'g'ri payload bilan; echo loop testida cheksiz halqa yuzaga
kelmaydi.

**TZ:** 2, 8-band ✅

---

## FAZA 11 — Rates va to'lov (`07`, `08`)

- `beds24-rate-sync`, source-of-truth konfiguratsiyasi.
- Teskari yo'nalish (`rate.changed`) — SoT ga bo'ysunishi.
- `payment.updated` oqimi to'liq ulanadi.
- Narx admin tomonidan qo'lda belgilanadi ([07 §8](07-AVAILABILITY-VA-RATES-SYNC.md)) — avtomatik/dinamik narxlash mexanizmi **yo'q**.

**Mezon:** narx ikki yo'nalishda ham to'g'ri ishlaydi, loop yo'q;
Beds24'dan kelgan to'lov Shaxmatkadagi "To'liq to'langan / Qarz bor"
belgisini to'g'ri ko'rsatadi.

**TZ:** 7, 14-band ✅

---

## FAZA 12 — Xavfsizlik va audit (`10`)

- JWT + RBAC (`ADMIN` / `MANAGER` / `STAFF`) to'liq tekshiriladi.
- `sanitizeForLog()` barcha log nuqtalariga ulanganini **grep bilan**
  tasdiqlash (`token`, `password`, `refreshToken` qidiriladi).
- `AuditLog` muhim amallarga ulanadi.
- Rate limiting, HTTPS, `.env` tekshiruvi.

**Mezon:** [10 §1](10-SECURITY-VA-SYNCLOG.md) jadvalidagi 9 ta talab ham "bajarildi".

**TZ:** 16, 18-band ✅

---

## FAZA 13 — Website integratsiyasi (`13`)

- Public API: `/api/public/availability`, `/api/public/reservations`.
- Avtomatik xona tanlash, `PENDING_PAYMENT` oqimi.
- To'lanmagan bronni avtomatik bekor qilish job'i.
- Bot himoyasi, rate limiting.
- **Website'ni ulash scope'dan tashqarida** — kodiga kirish yo'q.
  API mock so'rovlar bilan test qilinadi va kontrakt topshiriladi
  ([13 §8](13-WEBSITE-INTEGRATSIYA.md)).

**Mezon:** `POST /api/public/reservations` chaqirilganda →
Shaxmatkada darhol ko'rinadi → xona band bo'ladi → mock Beds24'ga
yuboriladi → availability kamayadi. Test skript bilan tasdiqlanadi.

**TZ:** 3-band ✅, 20-band (1-qism) ✅

---

## FAZA 14 — Fallback, drift va yuklama testi

- Polling fallback ([04 §8](04-WEBHOOK-HANDLER.md)) — webhook o'chirilib sinaladi.
- Drift tekshiruvi ([07 §6](07-AVAILABILITY-VA-RATES-SYNC.md)) — reconciliation job.
- To'liq tizim darajasida overbooking testi (Beds24 bilan birga).
- Beds24'ni butunlay o'chirib, PMS ishlashda davom etishi
  tekshiriladi (TZ 17, 19-band).

**Mezon:** webhook o'chirilgan holatda ham 15 daqiqada o'zgarishlar
tushadi; drift topilsa avtomatik tuzatiladi; Beds24 o'chirilganda
PMS to'liq ishlaydi.

**TZ:** 10 (fallback), 17, 19, 20-band ✅

---

## FAZA 15 — Topshirish (real Beds24'ga ulash)

Bu faza **dasturchi tomonidan** bajariladi. Bizning ish tugagan —
tizim to'liq ishlaydi, mock bilan test qilingan. Qoladigan ish: real
credentials qo'yish va sozlash.

### Dasturchi uchun qadamlar

```
1. Beds24 panelida invite code yaratish
   Settings → Account → Access → Generate invite code
   Scope: bookings (read+write), inventory (read+write), properties (read)

2. Credentials kiritish
   npm run beds24:connect
   → invite code so'raladi
   → refreshToken olinadi va shifrlab DB'ga yoziladi

3. .env da bitta o'zgaruvchi
   BEDS24_BASE_URL=https://api.beds24.com/v2   (mock o'rniga)

4. Webhook URL sozlash
   Beds24: Settings → Properties → Access → Booking webhooks
   URL: https://<domen>/api/webhooks/beds24/<token>
   (token .env dagi WEBHOOK_URL_TOKEN dan olinadi)

5. Mapping (Admin panel → Beds24 mapping)
   Har PMS xona turini Beds24 turiga bog'lash — 3 ta tanlov
   "Tekshirish" tugmasi → isComplete: true bo'lishi kerak

6. Tekshirish
   npm run beds24:verify
   → GET /properties javob beradimi
   → kredit limiti qancha
   → webhook yetib keladimi (test bron bilan)
```

### Agar haqiqat taxmindan farq qilsa

Kod **ikkala holatni ham qo'llab-quvvatlaydi**, faqat konfiguratsiya
o'zgaradi:

| Holat | Sozlama |
|---|---|
| Unit-level mapping kerak | Mapping ekranida "unit darajasi" yoqiladi |
| Webhook signature yo'q | `WEBHOOK_AUTH_MODE=ip_token` |
| Kredit limiti boshqa | `BEDS24_CREDIT_LIMIT=<son>` |
| Xona sonlari boshqa | Seed qayta ishga tushiriladi |

Hech bir holat kod o'zgartirishni talab qilmaydi.

### Nima ishlashini tekshirish (qabul mezoni)

```
☐ npm run beds24:verify — barcha tekshiruvlar yashil
☐ Beds24'da test bron → 3 soniyada Shaxmatkada ko'rinadi
☐ Shaxmatkada bron → Beds24 panelida ko'rinadi
☐ Xona band qilinsa → Beds24'da availability kamayadi
☐ Narx o'zgartirilsa → Beds24'da narx yangilanadi
☐ Beds24 o'chirilsa → PMS to'liq ishlayveradi
☐ Beds24 qaytsa → navbat o'z-o'zidan bo'shaydi
```

**Mezon:** yetti tekshiruv ham o'tadi.

**TZ:** 20-band (yakuniy natija) ✅


---

## TZ bandlari qamrovi

| TZ bandi | Faza | Hujjat |
|---|---|---|
| 1. Beds24 → PMS ma'lumot | 7 | `04` |
| 2. Shaxmatka → Beds24 | 10 | **`12`** |
| 3. Website → PMS → Beds24 | 2B, 13 | **`13`**, `07` |
| 4. OTA → Beds24 → PMS | 7, 8 | `04`, `09` |
| 5. Xona mapping | 5 | `06` |
| 6. Availability sync | 9 | `07` |
| 7. Rates sync | 11 | `07` |
| 8. Reservation status | 3, 10 | `08` |
| 9. Duplicate bronlar | 6, 7 | `02`, `04` |
| 10. Webhook | 6, 14 | `04` |
| 11. Sync queue | 7 | `05` |
| 12. Channel mapping | 1 | `01`, `02` |
| 13. Database | 1 | `02` |
| 14. To'lov | 11 | `08` |
| 15. Real-time | 8 | `09` |
| 16. Sync log | 12 | `10` |
| 17. Error holati | 14 | `05`, `07` |
| 18. Security | 12 | `10` |
| 19. Asosiy qoida | 14 | `01` |
| 20. Yakuniy natija | 13, 14, **15** | barchasi |

---

## Har faza oxirida hisobot

Ijrochi quyidagi shaklda hisobot beradi:

1. **Nima qilindi** — qisqa ro'yxat
2. **Qaysi fayllar o'zgardi**
3. **Qanday sinaldi** — real natija, taxmin emas
4. **Qaysi TZ bandi bajarildi**
5. **Keyingi faza uchun nima kerak** (masalan Beds24 sandbox
   ma'lumotlari, mijoz tasdig'i)

Shundan keyingina keyingi fazaga ruxsat so'raladi.
