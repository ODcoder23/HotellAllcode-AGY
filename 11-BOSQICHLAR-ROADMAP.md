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
- Beds24'da test/sandbox property mavjudligi **tasdiqlanadi**
  (mijozdan so'raladi, taxmin qilinmaydi).
- Mavjud Admin Panel va Website kodiga kirish olinadi.

**Mezon:** `docker compose up` ishlaydi, `/health` javob beradi.

---

## FAZA 0.5 — Beds24 haqiqatini aniqlash (kod yozilmaydi)

**Nega bu faza boshda turadi.** Hujjatlarning katta qismi Beds24
hisobi qanday sozlanganligi haqidagi **taxminlar** ustiga qurilgan:
xonalar room type darajasidami yoki har biri alohida unit'mi, webhook
signature beradimi, kredit limiti qancha. Bu javoblar
[02](02-DATABASE-SXEMA.md), [06](06-XONA-MAPPING.md),
[07](07-AVAILABILITY-VA-RATES-SYNC.md) va
[12](12-PMS-DAN-BEDS24-GA-SYNC.md) fayllarining asosini o'zgartirishi
mumkin. Ularni **kod yozilishidan oldin** bilish kerak — aks holda DB
va API taxmin ustiga quriladi va keyin qayta yoziladi.

### Bajariladigan ish

Faqat **o'qish** operatsiyalari. Hech narsa yozilmaydi, hech qanday
bronga tegilmaydi:

```
1. Invite code olinadi (Settings → Account → Access)
2. GET /authentication/setup → refreshToken
3. GET /authentication/token → accessToken
4. GET /properties      ← ASOSIY CHAQIRUV
5. GET /bookings?limit=5 (agar test bron bo'lsa)
```

### Aniqlanishi kerak bo'lgan 6 fakt

| № | Savol | Nimaga ta'sir qiladi |
|---|---|---|
| 1 | Xonalar room type darajasidami yoki unit darajasida? | [06 §2](06-XONA-MAPPING.md) — mapping darajasi; `ChannelMapping.externalUnitId` kerakmi |
| 2 | Nechta room type bor va ularning `id` lari? | [06 §3](06-XONA-MAPPING.md) — mapping ekrani |
| 3 | Har turda nechta xona (`qty`)? | [07 §2](07-AVAILABILITY-VA-RATES-SYNC.md) — agregatsiya to'g'rimi |
| 4 | Webhook signature/secret beradimi? | [04 §9](04-WEBHOOK-HANDLER.md) — validatsiya usuli |
| 5 | Kredit limiti (`x-five-min-limit-remaining`)? | [05 §3](05-SYNC-QUEUE-BULLMQ.md) — rate-limit chegarasi |
| 6 | Test/sandbox property bormi? | FAZA 6, 9, 10 — test qayerda o'tkaziladi |

### Natija

Javoblar `BEDS24-HAQIQAT.md` faylida qayd etiladi. Agar biror javob
hujjatdagi taxmindan farq qilsa — **tegishli fayl darhol tuzatiladi**,
keyingi fazaga o'tilmaydi.

**Mezon:** oltita savolga ham aniq javob bor; hujjatlar shu javoblarga
mos keltirilgan.

**TZ:** 5-band (mapping haqiqati), 18-band (credentials) — qisman

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
- `ChannelConnection` yaratiladi (invite code CLI skript orqali).
- Faqat `GET /properties` — **yozish operatsiyasi yo'q**.
- Beds24 hisobi unit-level sozlanganmi — shu yerda aniqlanadi
  ([06 §2](06-XONA-MAPPING.md)).

**Mezon:** property ro'yxati muvaffaqiyatli olinadi; token avtomatik
yangilanadi; kredit hisobi loglanadi.

**TZ:** 18-band (credentials) ✅

---

## FAZA 5 — Xona mapping (`06`)

- `ChannelMapping` CRUD API.
- Admin Panelga **yangi sahifa** (mavjudlari o'zgarmaydi).
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

**Mezon:** Shaxmatkada xona band qilinganda, Beds24 control panelida
shu sanalar uchun availability **to'g'ri songa** kamayadi
(6 → 5 → 4 ...).

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
- **Status mapping real `GET /bookings` javobi bilan tasdiqlanadi**
  (mock emas) — [08 §3](08-RESERVATION-STATUS-VA-TOLOV.md).

**Mezon:** sakkiz amalning har biri Beds24 panelida aks etadi;
cheksiz halqa yo'q.

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
- Mavjud Website shu API'ga ulanadi (UI o'zgarmaydi).

**Mezon:** Website'dan bron qilinsa → Shaxmatkada darhol ko'rinadi →
xona band bo'ladi → Beds24'ga yuboriladi → OTA availability kamayadi.

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
| 20. Yakuniy natija | 13, 14 | barchasi |

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
