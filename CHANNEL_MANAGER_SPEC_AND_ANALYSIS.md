# Channel Manager TZ — moslik tahlili

> **ARXIV (2026-09-26).** Egasi qarori bilan Beds24 / channel manager
> integratsiyasi PMS'dan to'liq olib tashlandi. Bu hujjat tarix uchun
> qoldirilgan — undagi kod havolalari endi mavjud emas. Joriy holat:
> [BEDS24.md](BEDS24.md), [PROJECT_LOGIC.md](PROJECT_LOGIC.md) 9-bo'lim.

**Yangilangan:** 2026-09-25, real Beds24 hisobi bilan tekshiruvdan keyin.

Bu hujjat Channel Manager integratsiyasi TZ'sining 19 bandini
amaldagi kod bilan solishtiradi. Oldingi versiya hamma bandni
"100% mos" deb baholagan edi — u baho faqat mock serverga
asoslangan edi. Real hisob API'si (faqat `GET`) bilan
solishtirilganda 15 ta nomuvofiqlik topildi va ular tuzatildi. Qolgan
ishlar pastda ko'rsatilgan. Keyingi tekshiruvda yana 4 ta topildi
(3-bo'lim, 16–19).

Texnik tafsilot: [BEDS24.md](BEDS24.md) · Qolgan ishlar:
[ISH_REJASI.md](ISH_REJASI.md) B-bo'lim

Belgilar: ✓ mos · ✓* 2026-09-25 da tuzatildi · ◐ qisman · ○ qilinmagan

---

## 1. Arxitektura

```
Booking.com · ETG/Ostrovok
            ↓
   Beds24 (markaziy, ustuvor)
            ↕  API v2 (token) + webhook
   PMS backend (Express, PostgreSQL, BullMQ)
            ↕  WebSocket
   Shaxmatka · Admin panel · Sayt   ← boshqaruv shu yerdan
```

Mijoz qarori Q9 (2026-09-25): **Beds24 tanlovi doim ustuvor.**
Batafsil: [BEDS24.md](BEDS24.md) 2-bo'lim.

---

## 2. 19 band bo'yicha holat

| № | TZ talabi | Amalda | Holat |
|---|---|---|:---:|
| 1 | PMS OTA'ga to'g'ridan-to'g'ri emas, channel manager (Beds24) orqali ulanadi | Yagona ko'prik Beds24 API v2. OTA bilan to'g'ridan-to'g'ri aloqa yo'q | ✓ |
| 2 | Ikki tomonlama almashinuv (READ + WRITE) | READ: webhook + polling (hamma statuslar). WRITE: bron, narx. Bo'sh joy sonini Q9 bo'yicha Beds24 o'zi hisoblaydi | ✓* |
| 3 | Kelgan bron maydonlari (id, kanal, mehmon, xona, sana, narx, status) DB'ga yoziladi | Kanal `channel` maydonidan (Ostrovok alohida manba), valyuta obyektdan, to'lov yuqori darajadagi `invoiceItems` dan, mamlakat `country2` dan, OTA raqami `externalReference` da, kelib chiqishi `origin = CHANNEL` | ✓ |
| 4 | Webhook tezkor qabul qilinadi, admin real vaqtda ko'radi | `POST /api/webhooks/beds24/:token`. Real v2 formati (`event` yo'q) qabul qilinadi. Beds24 imzo bermaydi — URL token rejimi. Beds24 tomonidagi sozlama ulash kuni | ✓* |
| 5 | Yangi OTA broni darhol paydo bo'ladi | Avtomatik xona biriktirish. Unit mapping endi xona turi bilan birga qidiriladi (ilgari boshqa turdagi xonaga tushishi mumkin edi) | ✓* |
| 6 | OTA bekor qilsa bron CANCELLED, xona bo'shaydi | Webhook ishlardi. Polling bekor qilinganlarni ko'rmasdi (Beds24 status'siz so'rovda ularni bermaydi) — tuzatildi | ✓* |
| 7 | O'zgarish (sana, xona, mehmon soni) UPDATE qilinadi, dublikat yo'q | Beds24'da xona turi yoki unit o'zgarsa PMS ham ergashadi (ilgari faqat sana). Xonadagi mehmon holati saqlanadi | ✓* |
| 8 | Band bo'lsa availability OTA'larga tarqaladi | Q9: Beds24 bo'sh joyni bronlardan o'zi hisoblaydi, PMS bronni yuboradi (`checkAvailability` bilan). Ta'mir yopilishi ikki tomonlama: PMS -> Beds24 `black` bron, Beds24 `black` -> PMS kunlari (`ChannelBlock`, B2) | ✓ |
| 9 | Narx sinxronizatsiyasi | PMS -> Beds24 darhol, Beds24 -> PMS soatlik (`pullRates`). Beds24 narx webhook'i yubormaydi — ilgari teskari yo'nalish ishlamas edi. Tizim USD (Q13) — valyuta mos, narx sinxronlanadi | ✓ |
| 10 | Parametrlar: bo'sh joy, narx, min/max stay, yopiq, kelish/ketish taqiqi | Narx va `minStay` ha. Max stay, yopiq kun, CTA/CTD sinxronlanmaydi | ◐ |
| 11 | Xona mapping DB'da saqlanadi | Tur + unit darajasi. Unit'lar nom bo'yicha avtomatik bog'lanadi (`POST /api/admin/mapping/auto-units`). `/properties` endi `includeAllRooms=true` bilan — ilgari mapping sahifasi bo'sh qolardi | ✓* |
| 12 | Hisob ulash, kalitlar xavfsiz saqlanadi | AES-256. Refresh token almashishi endi saqlanadi (ilgari birinchi almashishda ulanish uzilardi). Ulash faqat CLI orqali (`npm run beds24:connect`), invite code yoki refresh token bilan. Admin paneldan ulash yo'q (eski hujjatdagi `/api/admin/channel/connect` mavjud emas edi) | ◐ |
| 13 | Bir nechta provayder | `ChannelAdapter` + `registry.ts` | ✓ |
| 14 | Alohida servis arxitekturasi | `ping`, `getRoomTypes`, `pullReservations`, `pushReservation`, `pushAvailability`, `pushRates`, `getAvailability`, `getRates`, `getCurrency`, `parseWebhook` | ✓ |
| 15 | Webhook + polling fallback | Polling 15 daqiqa (hamma statuslar, sahifalash), narx soatlik, drift kunlik | ✓* |
| 16 | Sync log | `SyncLog`, admin panelda `/admin/sync-log.html` | ✓ |
| 17 | Dublikat himoyasi | `@@unique([channelId, externalReservationId])` + webhook `payloadHash` | ✓ |
| 18 | To'liq ikki tomonlama oqim | Q9 yo'nalishlari bilan: [BEDS24.md](BEDS24.md) 2-bo'lim jadvali | ✓* |
| 19 | Tizim "ko'prik" bo'lishi | Ha. OTA broni PMS'da cheklangan: sana, narx va bekor qilish OTA'da qilinadi | ✓* |

---

## 3. Real hisob bilan tekshiruvda topilgan xatolar

Hammasi 2026-09-25 da tuzatildi. Mock bu xatolarni ko'rsatmas edi —
mock ham real xatti-harakatga keltirildi.

| # | Xato | Oqibati | Joy |
|---|---|---|---|
| 1 | Almashgan refresh token saqlanmasdi | Birinchi almashishda ulanish butunlay uzilardi | `beds24/auth.ts` |
| 2 | `/properties` `includeAllRooms`siz | Mapping sahifasida Beds24 xonalari chiqmasdi | `beds24/adapter.ts` |
| 3 | Unit faqat id bo'yicha qidirilardi | Bron boshqa turdagi xonaga tushishi mumkin edi | `mapping.ts` `findByExternal` |
| 4 | Polling status'siz so'rardi | OTA bekor qilishi polling orqali kelmasdi | `adapter.ts` `pullReservations` |
| 5 | Polling sahifalamasdi | 100 dan ortiq o'zgarishda qolganlari yo'qolardi | `adapter.ts` |
| 6 | Kalendar `include*`siz so'ralardi, oraliqlar yoyilmasdi | Drift tekshiruvi hech narsa ko'rmasdi | `adapter.ts` `getAvailability` |
| 7 | Valyuta "USD" qattiq yozilgan, narx valyutasiz yuborilardi | So'mdagi narx dollar bo'lib OTA'ga ketardi | `adapter.ts`, `rates.ts`, `reservationSync.ts` |
| 8 | `subStatus: arrived/departed` yuborilardi | Beds24'da yo'q — check-in yuborilmasdi | `statusMap.ts` |
| 9 | `black` NO_SHOW deb o'qilardi va NO_SHOW `black` bo'lib ketardi | Yopilgan xona "kelmagan mehmon", kelmagan mehmon "yopilgan xona" bo'lardi | `statusMap.ts` |
| 10 | OTA bronini yangilashda `referer: "PMS"` va narx yozilardi | Booking.com broni buzilardi, keyingi haqiqiy bekor qilish "aks-sado" deb tashlanardi | `adapter.ts` |
| 11 | `new` + to'lovsiz -> PENDING_PAYMENT, 24 soatda avtomatik bekor | Haqiqiy OTA broni tizim tomonidan bekor qilinib, Beds24'ga yuborilardi | `statusMap.ts`, `publicBooking.ts` |
| 12 | Webhook to'lovlarni bron ichidan qidirardi | OTA to'lovi PMS'ga tushmasdi | `adapter.ts` `parseWebhook` |
| 13 | Beds24'dan narx faqat webhook bilan kutilardi | Beds24 bunday webhook yubormaydi — teskari yo'nalish ishlamasdi | `rates.ts` `pullRates` |
| 14 | Webhook yangilanishi statusni qaytarardi | Check-in qilingan mehmon CONFIRMED ga qaytardi | `statusMap.ts` `mergeIncomingStatus` |
| 15 | PMS `numAvail` ni o'z hisobidan yozardi | OTA broni bilan poygada sotilgan xona qayta ochilishi mumkin edi | `availability.ts` (Q9) |
| 16 | `referer: "PMS"` bronga kelgan har webhook "aks-sado" deb tashlanardi | Beds24 panelida PMS bronining sanasi o'zgartirilsa PMS bilmay qolardi (real Beds24 bizning yozuvimizga webhook yubormaydi) | `webhookProcessor.ts` `matchesPms` |
| 17 | 2026-09-16 gacha bronlar so'mdagi summa bilan `USD` yorlig'ida (seed ham) | Beds24 (USD) ga narx sifatida ketsa 800 000 dollar bo'lardi. Hal qilindi: tizim USD, eski test ma'lumoti tozalanadi (Q13) | `reservationSync.ts`, `seed.ts`, `scripts/reset-test-data.ts` |
| 18 | Bitta 429 dan keyin 5 daqiqagacha hech bir so'rov ketmasdi | Kredit tiklangan bo'lsa ham bron va narx kechikardi | `client.ts` (30 s da sinov so'rovi) |
| 19 | Yuborish o'rtasida restart bo'lsa bron `SYNCING` da abadiy qolardi | Bron Beds24'ga hech qachon yetmasdi — overbooking xavfi | `reservationSync.ts` |

### USD va B2 bosqichida topilganlar (2026-09-25)

| # | Xato | Oqibati | Joy |
|---|---|---|---|
| 20 | SoT = beds24 bo'lganda PMS'dagi ta'mir yopilishi Beds24'ga umuman yetmasdi | Booking.com yopiq xonani sotishda davom etardi | `channelBlocks.ts` (`black` bron) |
| 21 | Beds24 panelidagi `black` faqat ogohlantirish edi | PMS yopiq xonaga bron qo'yishi mumkin edi | `channelBlocks.ts` `applyChannelBlock` |
| 22 | Bekor qilish jarimasi `channelId` bo'yicha o'chirilardi | Beds24'ga yuborilgan HAR bir sayt/qabulxona broni jarimasiz bekor bo'lardi | `reservations.ts` (`origin` bo'yicha) |
| 23 | OTA egaligi `source` nomidan taxmin qilinardi (`OTHER` — Beds24'dan so'rov) | Ostrovok broni PMS'da tahrirlanib, OTA broni buzilishi mumkin edi | `Reservation.origin`, `channelOwnership.ts` |
| 24 | Nonushta bronga keyin yoqilsa narxi ko'chirilmasdi | Oshxona sanardi, summa qo'shilmasdi — bepul ovqat | `reservations.ts` `updateReservation` |
| 25 | "Tarifdan past" faqat kirish kuni tarifi bilan solishtirilardi | Juma qimmat bo'lsa sayt o'rtacha narxda sotib, o'z bronini rad etardi | `reservations.ts` `tariffStayTotal` |
| 26 | Hisobot: nonushta va jarima daromadda yo'q, xizmatlar har oyda qayta sanalardi, "qarz" = davr daromadi − davr to'lovi | Daromad va qarz noto'g'ri | `report.ts`, `stats.ts` (`lib/money.ts`) |
| 27 | OTA komissiyasiga mehmonxonadagi xizmatlar (mini-bar) ham kirardi | Xarajat bo'rtib chiqardi | `expenses.ts` |
| 28 | Summalar float bilan qo'shilib butun songa yaxlitlanardi | Dollarda sent yo'qolardi, $0.00000001 "qarz" to'lovni rad etardi | `lib/money.ts` (sentda) |
| 29 | OTA jami narxi kechalarga 2 xona bilan bo'linardi | $100 / 3 kecha -> $99.99 | `pricePerNight` 4 xona |
| 30 | Sayt narxi o'rtacha × kecha, sentga yaxlitlangan | Tariflar yig'indisidan farq qilardi | `stayPriceFromRates` |

---

## 4. Tekshiruv (2026-09-25, oxirgi holat)

Jonli bazaga tegmasdan — vaqtinchalik mahalliy klaster (:55433),
alohida Redis, mock `MOCK_CURRENCY=USD`, `PMS_CURRENCY=USD`:

- `mock-beds24/mock.test.ts` — **42/42** (bazasiz).
- Backend: 18 fayl, **424/424** — `AUTH_REQUIRED=false` va `true`
  (ishlab chiqarishga yaqin, ADMIN token) ikkala rejimda ham.
  Yangi: `beds24Real` (real API moslik), `channelBlocks` (xona yopish
  ikki yo'nalishda, 8), `usd` (to'lov sentlari, nonushta narxi,
  jarima, hisobot davrlari, 8), `money` (formula, 13).
- Avvalgi 36 ta yiqiluvchi test (eski fixture'lar) tuzatilgan.
- B2 migratsiyasi test bazasida qo'llangan, `prisma migrate diff` —
  sxema bilan farq yo'q. `scripts/reset-test-data.ts` test bazasida
  sinalgan (quruq rejim, noto'g'ri nom rad etiladi, keyin tozalash).
- Frontend (Shaxmatka, admin panel, sayt, admin sahifalari) — vendor
  Babel bilan kompilyatsiya tekshiruvi.

---

## 5. Kod tuzilmasi

```
backend/src/
├── services/
│   ├── channel/
│   │   ├── types.ts          ChannelAdapter interfeysi (TZ 13, 14)
│   │   ├── registry.ts       provayderlar ro'yxati
│   │   └── propertyCache.ts  /properties keshi
│   ├── beds24/
│   │   ├── adapter.ts        real API formati <-> PMS shakli
│   │   ├── client.ts         HTTP, kredit, 401/429
│   │   ├── auth.ts           token, almashish, shifrlash
│   │   └── statusMap.ts      status va bayroq xaritasi, Q9 qoidasi
│   ├── webhook.ts            webhook validatsiya, dedup, navbat
│   ├── webhookProcessor.ts   bronni yaratish/yangilash
│   ├── reservationSync.ts    PMS -> Beds24 bron
│   ├── channelBlocks.ts      xona yopish <-> Beds24 black (B2)
│   ├── mealPrice.ts          nonushta narxi, faol bronlarga qo'llash
│   ├── mapping.ts            mapping, auto-units, health
│   ├── availability.ts       bo'sh joy hisobi (SoT=pms da yuborish)
│   ├── rates.ts              narx: yuborish va pullRates
│   ├── reconciliation.ts     polling, drift, catch-up
│   └── settings.ts           SoT, PMS valyutasi
├── lib/
│   ├── money.ts              yagona pul formulasi (USD, sentda)
│   ├── moneySchema.ts        USD chegaralari (Zod)
│   └── channelOwnership.ts   OTA egaligi (origin bo'yicha)
├── queues/                   BullMQ worker'lar va jadval
└── routes/
    ├── admin.ts              mapping, ulanish holati, maintenance
    └── webhooks.ts           POST /api/webhooks/beds24/:token
```
