# 03 — Beds24 API v2 integratsiyasi

Manba: `wiki.beds24.com` (API V2 rasmiy hujjatlari), 2026 holatiga ko'ra
tekshirilgan. **API V1 ishlatilmaydi** — u eskirgan (deprecated), faqat
V2 (`https://api.beds24.com/v2`) ishlatiladi.

## 1. Autentifikatsiya oqimi

```
1. Beds24 control panel → Settings > Account > Access
   → "Generate invite code" bosiladi, kerakli scope'lar tanlanadi
2. Invite code backend orqali almashtiriladi:
   GET /authentication/setup
   Header: code: {inviteCode}
   → javobda: { token, expiresIn, refreshToken }
3. refreshToken DB'da (ChannelConnection.refreshToken) shifrlangan holda saqlanadi
4. Har safar kerak bo'lganda:
   GET /authentication/token
   Header: refreshToken: {refreshToken}
   → yangi access token (24 soat amal qiladi)
5. Barcha keyingi so'rovlarda:
   Header: token: {accessToken}
```

- Access token 24 soat amal qiladi — **har so'rov uchun yangisini
  olish taqiqlanadi**, chunki bu kredit sarflaydi. Token cache
  qilinadi (`ChannelConnection.accessToken` + `accessTokenExpiresAt`),
  muddati tugashiga yaqinda yangilanadi.
- Read-only uzoq muddatli token ham mavjud — faqat kuzatuv/monitoring
  maqsadida ishlatilishi mumkin, yozish operatsiyalari uchun emas.

## 2. Foydalaniladigan asosiy endpointlar

| Endpoint | Metod | Vazifa |
|---|---|---|
| `/bookings` | GET | Bronlarni olish (filtr: property, room, arrival/departure, status, modification time) |
| `/bookings` | POST | Yangi/yangilangan bron yozish, status, note qo'shish |
| `/inventory/rooms/calendar` | POST | Narx va mavjudlik (availability, minStay) yangilash |
| `/inventory/rooms/calendar` | GET | Joriy narx/availability holatini olish |
| `/properties` | GET | Property/room type ro'yxati (mapping sozlash uchun) |
| `/webhooks/bookings` | POST (Beds24 tomonidan chaqiriladi) | Real-time bron xabarnomasi |

**MUHIM:** Xona/room-type mapping Beds24 tomonida **API orqali
sozlanmaydi** — faqat ularning control panelida qo'lda qilinadi.
Bizning `ChannelMapping` jadvalimiz — shu tashqi (qo'lda qilingan)
mappingni ichki tizimimizda saqlash va tekshirish uchun.

## 3. Rate limit (kredit tizimi) — juda muhim, arxitekturaga bevosita ta'sir qiladi

- Cheklov account darajasida, **5 daqiqalik aylanma oyna** bo'yicha,
  standart 100 kredit.
- Har so'rov murakkabligiga qarab kredit sarflaydi (statik emas,
  dinamik hisoblanadi).
- Har javobda headerlar keladi:
  - `x-five-min-limit-remaining`
  - `x-five-min-limit-resets-in`
  - `x-request-cost`
- Beds24'ning o'z tavsiyasi: **API real-time, yuqori chastotali
  so'rovlar uchun mo'ljallanmagan.** Har bir foydalanuvchi harakatiga
  javoban to'g'ridan-to'g'ri Beds24'ga so'rov yubormaslik kerak.
- POST payload cheklovi: ~1MB, massivda ≤10000 top-level element.
- Amaliy xulosa: barcha yozish operatsiyalari **navbat (queue)
  orqali**, guruhlab (batch) yuboriladi — `05-SYNC-QUEUE-BULLMQ.md`ga
  qarang. O'qish uchun esa iloji boricha webhook ishlatiladi, GET
  so'rovlar minimallashtiriladi (Beds24'ning o'zi ham buni tavsiya
  qiladi: "if you need data such as new bookings when they come in,
  use webhooks instead of frequent GET requests").

## 4. Beds24 Integration Service (backend modul strukturasi)

```
services/beds24/
  auth.ts           // token olish/yangilash, cache
  client.ts         // umumiy HTTP wrapper — har javobda rate-limit headerlarni o'qib,
                     // kerak bo'lsa keyingi so'rovni kechiktiradi
  bookings.ts        // GET/POST /bookings wrapper
  calendar.ts        // POST/GET /inventory/rooms/calendar wrapper
  mapping.ts          // ChannelMapping bilan ishlash
  webhookHandler.ts   // kiruvchi webhook'ni qabul qilish (04-ga qarang)
```

`client.ts` — yagona joy, undan tashqarida hech qayerda to'g'ridan-to'g'ri
`fetch("api.beds24.com/...")` chaqirilmaydi. Bu qoidaning maqsadi:
rate-limit va retry mantig'ini bitta joyda ushlab turish.

## 5. Credentials xavfsizligi

- `refreshToken` va `accessToken` DB ustunida **app-level shifrlash**
  bilan saqlanadi (masalan AES-256, kalit `.env`da, `.env` repoga
  kirmaydi).
- Hech qanday token log qilinmaydi (`10-SECURITY-VA-SYNCLOG.md`).
- Frontend (Admin Panel) faqat "ulangan/ulanmagan" holatini ko'radi,
  tokenning o'zini hech qachon olmaydi.

---

## 6. TZ bandlari bilan bog'liqlik

Bu hujjat `TZ-ASL.md` ning quyidagi bandlariga xizmat qiladi:

| TZ bandi | Shu hujjatdagi qism |
|---|---|
| 13-band — "Beds24 API credentials frontendga chiqmasin" | §5 |
| 18-band — ".env / secure storage" | §5 |
| 10-band — webhook | §2 (`/webhooks/bookings`), tafsilot `04`-faylda |
| 6-band — availability sync | §2 (`/inventory/rooms/calendar`) |
| 7-band — rates sync | §2 (o'sha endpoint, `price1`) |
| 1, 2-band — bronlarni olish/yuborish | §2 (`/bookings` GET/POST) |
| 5-band — mapping | §2 (`/properties`) + **muhim cheklov**: mapping API orqali sozlanmaydi |
| 11, 17-band — queue, retry | §3 (rate limit) → `05`-fayl |

## 7. Endpoint'lar — qaysi hujjatda ishlatiladi

| Endpoint | Yo'nalish | Hujjat |
|---|---|---|
| `GET /authentication/setup` | — | FAZA 4 |
| `GET /authentication/token` | — | §1, avtomatik |
| `GET /properties` | Beds24 → PMS | `06` §3 (faqat mapping ekranida) |
| `GET /bookings` | Beds24 → PMS | `04` §8 (polling fallback) |
| `POST /bookings` | PMS → Beds24 | **`12` §3** (TZ 2-band, 8 amal) |
| `GET /inventory/rooms/calendar` | Beds24 → PMS | `07` §6 (drift tekshiruvi) |
| `POST /inventory/rooms/calendar` | PMS → Beds24 | `07` §4 (availability), §7 (rates) |
| Webhook (Beds24 chaqiradi) | Beds24 → PMS | `04` |

## 8. Kredit sarfini kamaytirish — jamlangan ro'yxat

5 daqiqada ~100 kredit cheklovi butun arxitekturaga ta'sir qiladi.
Barcha tejash choralari:

1. **Token cache** — 24 soat, har so'rovda yangilanmaydi (§1)
2. **Webhook > polling** — asosiy oqim real-time webhook (`04`)
3. **`modifiedFrom` filtri** — polling'da faqat o'zgarganlar (`04` §8)
4. **`syncedCount` solishtiruvi** — o'zgarmagan kunlar yuborilmaydi (`07` §4)
5. **Ketma-ket kunlarni birlashtirish** — bitta oraliq (`07` §4)
6. **Debounce 2–3 soniya** — bir necha o'zgarish bitta job'ga (`05` §2c)
7. **`/properties` cache** — mapping ekranidan tashqarida chaqirilmaydi (`06` §3)
8. **Rate-limit-aware kechiktirish** — kredit tugasa job kutadi (`05` §3)
