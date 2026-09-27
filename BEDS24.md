# Beds24 — ikki tomonlama integratsiya

**Holat (2026-09-27, egasi qarori Q19).** Beds24 integratsiyasi
**avvalgidek qaytdi**: Beds24 bronlari PMS'ga tushadi; PMS bronlari,
narxlari va yopiq kunlari Beds24'ga yuboriladi. 2026-09-26 dagi olib
tashlash (Q18) va 2026-09-27 ertalabki "faqat kuzatuv" rejimi bekor.
STOP (Q17) butunlay olib tashlandi — sotuvni to'xtatish Beds24 panelida.

Qarorlar: [zakas042/TZ-ASL.md](zakas042/TZ-ASL.md) (Q9, Q15, Q19).

---

## 1. Qoidalar — kim nimani o'zgartiradi

**Beds24 ustuvor (Q9).** Beds24 — markaziy tizim, Shaxmatka — uni
boshqarish oynasi.

| Nima | Qayerda o'zgaradi | PMS'da |
|---|---|---|
| OTA broni (Booking.com, Ostrovok...) sanasi, narxi, mehmon soni, bekor qilish | OTA'da | qulf — `409 CHANNEL_OWNED`, tugmalar yashirin |
| OTA bronida kirish/chiqish, to'lov, izoh, nonushta, shu turdagi xonaga ko'chirish | PMS'da | Beds24'ga faqat xona va belgi (`flagText`) ketadi |
| Qabulxona / sayt broni | PMS'da | Beds24'ga to'liq yuboriladi |
| Xona yopish (ta'mir) | PMS'da | Beds24'da `black` bron bo'ladi; ochilsa bekor qilinadi |
| Beds24 panelida yopilgan xona (`black`) | Beds24'da | PMS'da yopiladi, PMS ocholmaydi (`409`) |
| Tarif narxi | admin (PMS, so'm) | Beds24'ga `so'm / bugungi kurs = $` bo'lib ketadi |
| Beds24 panelidagi narx (tur darajasida bog'langan tarif) | Beds24'da | soatlik tortiladi; yuborilmagan PMS narxi ustiga yozilmaydi |
| Cheklovlar: kamida / ko'pi bilan kecha, kirish / chiqish taqiqi (TZ 10) | admin (Narxlar) yoki Beds24 paneli | narx bilan birga Beds24'ga; PMS boshqarmaydigani (bo'sh) yuborilmaydi; tur darajasida — Beds24'dagisi soatlik tortiladi |
| Mehmon ma'lumoti (ism, telefon, email) — TZ 7 | OTA broni — OTA'da; PMS broni — PMS'da | OTA bronida Beds24'dagidek yangilanadi; PMS bronida faqat bo'sh maydon to'ldiriladi |

- PMS Beds24'ga `numAvail` **yozmaydi** — Beds24 bo'sh joyni bronlar va
  `black` dan o'zi hisoblaydi. TZ 8-band ("availability yuborish") shu
  bilan bajariladi: bron yoki yopish Beds24'ga yetishi bilan son kamayadi
  va OTA'larga tarqaladi. `numAvail` ham yozilsa bitta bron ikki marta
  ayirilardi. Farq har kuni 04:00 da tekshiriladi (faqat qayd).
- Kirish/chiqish taqiqi Beds24'da `override` maydoni — kunni butunlay
  yopish (`blackout`) ham shu yerda. Beds24 panelida yopilgan
  (`blackout` / `exception`) kunga PMS taqiqi **yozilmaydi** — kun ochilib
  ketmasin. Closed/Open (STOP) PMS'da yo'q — Beds24 panelida.
- PMS broni `checkAvailability` bilan yuboriladi. Beds24'da joy yo'q bo'lsa
  bron **`REJECTED`** bo'ladi va **avtomatik qayta yuborilmaydi** (2026-09-26
  dagi shovqin sababi shu edi). Xodim xona yoki sanani o'zgartiradi,
  bekor qiladi yoki "Qayta yuborish" bosadi (egasi, admin).
- Qo'lda kiritilgan OTA broni (manba Booking.com va h.k.) Beds24'ga
  **yuborilmaydi** — u yerda allaqachon bor. Import uni OTA raqami
  (`externalReference`) yoki sanalar + tarif + manba bo'yicha (yagona
  nomzod) topib **bog'laydi** — dublikat bo'lmaydi.
- Beds24 broni tushgan xona PMS'da band bo'lsa — mehmon shu turdagi bo'sh
  xonaga joylanadi (avval Beds24'ga bog'lanmagan xona), egasiga Telegram
  ogohlantirishi ketadi. Bo'sh xona umuman yo'q — "qo'lda hal qilish".
- Bog'lanmagan xona/unit: bronlari yuborilmaydi (`NOT_APPLICABLE`, xato
  emas), Beds24 bronlari PMS'ga tushmaydi (jurnalda "qo'lda hal qilish").
  Bog'langanda hammasi avtomatik: Beds24'dan to'liq import, yuborilmagan
  PMS bronlari va yopiq kunlar Beds24'ga.

## 2. Valyuta (Q15, Q19)

- Tizim **so'mda**. Beds24 obyekti — USD.
- Beds24'dan kelgan bron **dollarda** qoladi, tagida so'm — **bron kelgan
  kundagi** Markaziy bank kursi (bronga yoziladi, qotadi).
- Shaxmatkada **hamma xodimga** ikki xil ko'rinadi: asl `$` va so'm.
- To'lov **so'mda** qabul qilinadi — **bron kursi** bilan dollarga
  o'giriladi, asl so'm to'lovda saqlanadi. Xodim xohlasa `$` da kiritadi.
- Hisobot so'mda: dollar bron — bron kursi bilan, kassa — tushgan so'm.
- Kurs: Markaziy bankdan har 3 soatda; admin qo'lda o'zgartira oladi
  (Xona turlari → Dollar kursi). Mavjud bronlar kursi o'zgarmaydi.

## 3. Ruxsatlar

| Rol | Channel manager | Dollar bron |
|---|---|---|
| FOUNDER, ADMIN | ulash, bog'lash, qo'lda amallar, kurs, "Qayta yuborish" (`channel.write`) | ko'radi |
| MANAGER | holat, jurnal, bronlar — faqat ko'rish (`channel.read`) | ko'radi |
| STAFF | yo'q (403) | ko'radi, so'mda to'lov oladi |

## 4. Ulash

1. Serverda `.env`: `ENCRYPTION_KEY` (64 hex, token AES-256-GCM bilan
   shifrlanadi). Kalit yo'q bo'lsa "Ulash" invite code'ni **ishlatmasdan**
   rad etadi — kod yonib ketmaydi. Kalit o'zgarsa qayta ulash kerak.
2. Beds24 → Settings → Marketplace → API → **invite code**. Ruxsatlar:
   bookings (o'qish + **yozish**, shaxsiy va moliyaviy), inventory
   (o'qish + **yozish**), properties (o'qish). Faqat o'qish bilan ulansa
   panel ogohlantiradi — bronlar va narx yuborilmaydi.
3. Admin panel → Channel manager → Ulash → invite code (yoki ishlatilgan
   bo'lsa refresh token; obyekt ID ixtiyoriy, noto'g'ri ID rad etiladi).
   Hisobda bir necha obyekt bo'lsa — Ulanish sahifasi → "Obyekt":
   boshqa obyektga o'tilsa eski obyekt bog'lanishlari o'chadi (qaytib
   o'tilganda tiklanadi), bronlar yangi obyektdan to'liq o'qiladi.
4. "Unit'larni avtomatik bog'lash" (unit nomi = PMS xona raqami),
   qolganini qo'lda. Bog'langach import va yuborish fonda boshlanadi.
5. Webhook: `.env` da `WEBHOOK_URL_TOKEN` (16+ belgi; o'rnatishda
   serverda yaratiladi). To'liq URL — Ulanish sahifasida "Webhook URL"
   (faqat egasi va admin ko'radi). Beds24 → Settings → Properties →
   Access → Booking Webhook: shu URL, versiya `twoWithPersonalData`.
   Webhook bo'lmasa bronlar polling bilan keladi (5 daqiqa).
6. Mavjud PMS narxlari Beds24'ga **avtomatik yuborilmaydi** (Booking.com
   narxi kutilmaganda o'zgarmasin). Kerak bo'lsa: Narxlar → "Beds24'ga
   yuborish" yoki narxni qayta saqlash.

**Real hisobga ulash (2026-09-28):** server bo'sh bazadan qayta
o'rnatilgan — PMS'da bron va yopiq kun yo'q, shuning uchun import
Beds24'dagi bronlarni to'g'ridan-to'g'ri tushiradi. Tartib —
[ISHGA_TUSHIRISH.md](ISHGA_TUSHIRISH.md) D bo'limi.

## 5. Oqimlar va navbatlar (TZ 11-band)

| Navbat | Nima |
|---|---|
| `beds24-reservation-sync` | PMS broni → Beds24 (2 s oyna, oxirgi holat yuboriladi) |
| `beds24-availability-sync` | xona yopish/ochish → `black` (3 s oyna) |
| `beds24-rate-sync` | narx → Beds24 (3 s debounce) |
| `beds24-webhook` | kelgan webhook → PMS |
| `beds24-retry` | bir necha urinishdan keyin ham bajarilmagan vazifa (Channel manager → Yiqilgan vazifalar) |
| `pms-maintenance` | polling (`POLL_INTERVAL_MINUTES`, standart 5 — TZ 15-band; 0 — Beds24 jadvallari o'chiq), catch-up (`CATCH_UP_INTERVAL_MINUTES`, 15), narx va cheklov tortish (soatlik), bo'sh joy farqi (04:00, faqat qayd), kurs (3 soat) |

Birinchi polling (va bog'lanish o'zgarganda) — to'liq: Beds24'dagi barcha
faol bronlar. Keyingilari — `modifiedFrom` bilan faqat o'zgarganlar.
Redis ishlamasa PMS to'xtamaydi: bron `PENDING` qoladi, catch-up yuboradi.

**Muammolar qayerda:** Channel manager → Bronlar ("Muammoli": rad
etilgan / xato / kutmoqda, sababi bilan), Sinxronizatsiya (jurnal:
Provider, amal, xona/tarif, sana, qiymat, holat, xato — TZ 16-band;
yiqilgan vazifalar), Umumiy hisobot → Kanal (Beds24). Telegram — faqat
overbooking xavfida (joy yo'q, mehmon boshqa xonaga joylandi).

**Bitta bronni Beds24'dan qayta olish:** Shaxmatka → bron → "Beds24'dan
yangilash" (egasi, admin) — webhook bilan bir xil yo'l; yuborilmagan PMS
o'zgarishi ustiga yozilmaydi.

**TZ 14-band metodlari ↔ kod** (`services/channel/types.ts` `ChannelAdapter`):

| TZ | Kod |
|---|---|
| `connect()` | `connect()`, `disconnect()`, `connectionStatus()`, `listProperties()`, `selectProperty()` |
| `getProperties()`, `getRooms()` | `getRoomTypes()` (obyekt va uning xona turlari/unit'lari birga) |
| `getBookings()` | `pullReservations(since)`, `pullActiveReservations()` |
| `getBooking()` | `getBooking(externalId)` |
| `updateAvailability()` | `pushAvailability()` — Beds24'da chaqirilmaydi (1-bo'lim) |
| `updatePrices()`, `updateRestrictions()` | `pushRates()` — narx va cheklovlar bitta so'rovda |
| `updateBooking()`, `cancelBooking()` | `pushReservation()` (status bilan), xona yopish — `pushBlock()` |

## 6. Real API faktlari

Real hisobda yoki rasmiy spetsifikatsiyada
(`https://beds24.com/api/v2/apiV2.yaml`) tekshirilgan; soxta server
(`backend/src/channel.test.ts`) shu xulqni takrorlaydi.

**Token**
- `GET /authentication/setup` (header `code`) — invite code → refresh token.
- `GET /authentication/token` (header `refreshToken`) → access token, 24 soat.
- **Refresh token almashadi:** javobda yangi `refreshToken` kelsa, eskisi
  o'sha zahoti o'ladi — yangisi darhol saqlanadi, parallel yangilashlar
  bittaga birlashtiriladi. 30 kun ishlatilmasa o'ladi (polling tirik tutadi).
- Scope yetishmasa ham `401 Token not valid`. `GET /authentication/details`
  — token ruxsatlari.

**Kredit:** 5 daqiqada ~100. Har javobda `X-Five-Min-Limit-Remaining`,
`X-Five-Min-Limit-Resets-In`, `X-Request-Cost`. 429 — kredit tugagan.

**Obyekt:** `GET /properties` xona turlarini faqat `includeAllRooms=true`
bilan beradi. Valyuta obyekt darajasida (real hisob — USD). Xona turi =
`roomId`, jismoniy xona = `unit`; **unit id har turda 1 dan boshlanadi** —
faqat `roomId` bilan birga noyob.

**Bronlar**
- `GET /bookings`: status berilmasa bekor qilinganlar kelmaydi — hamma
  status aniq so'raladi. Javob sahifalanadi (`pages.nextPageExists`).
- Manba: `apiSource` ("Booking.com"), `channel` ("booking", "direct"),
  `apiReference` — OTA bron raqami. `black` — xona yopilishi, `inquiry` —
  so'rov (bron emas). `subStatus` da `arrived`/`departed` yo'q — kirish/
  chiqish `flagText` bilan belgilanadi.
- `POST /bookings`: massiv; yangi bron — `actions.checkAvailability`,
  javobda `new.id`; o'zgartirish — `id` bilan, javobda `modified.id`.
  Joy yo'q — `errors[].message` da "availability".

**Kalendar:** `GET /inventory/rooms/calendar` — `include*` bayroqlarisiz
(`includeNumAvail`, `includePrices`, `includeMinStay`, `includeMaxStay`,
`includeOverride`) **bo'sh** keladi; kunlar oraliqqa siqilgan
(`{from, to, numAvail, price1, ...}`); narxsiz kun — yopiq. `minStay` /
`maxStay` kalendarda bo'lmasa xona standarti qaytadi. Yuborish —
`POST /inventory/rooms/calendar`: `price1`, `minStay` (1–365), `maxStay`
(1–364), `override` (`none`, `blackout`, `exception`, `noCheckIn`,
`noCheckOut`, `noCheckInOrCheckOut`). Berilmagan maydon o'zgarmaydi,
`null` — olib tashlanadi. PMS faqat o'zi boshqaradigan cheklovni yuboradi.

**Webhook:** payload `{timeStamp, booking, invoiceItems, retries, ...}`,
`event` maydoni yo'q. **Imzo yo'q** — himoya URL'dagi maxfiy token. Takror
yuborishda `retries` oshadi — mazmun bir xil bo'lsa `duplicate`. Narx
o'zgarishi uchun webhook yo'q (soatlik tortiladi).

## 7. Tarix (qisqa)

- **2026-09-25/26:** real hisob tahlili — `SyncLog` 17 983 yozuv (asosan
  mapping yo'qligidan qayta-qayta FAILED), Beds24'da 4 ta bron PMS'da yo'q edi.
- **2026-09-26:** integratsiya olib tashlandi (Q18), migratsiya
  `20260926200000_remove_beds24`. Zaxiralar serverda.
- **2026-09-27 ertalab:** egasi uchun "faqat kuzatuv" rejimi.
- **2026-09-27 kechqurun (Q19):** integratsiya qaytdi, migratsiya
  `20260927120000_beds24_restore` (kuzatuv jadvallari o'chadi, STOP
  sozlamasi va kelgusi STOP kunlari ochiladi). Olib tashlashga olib kelgan
  sabablar tuzatildi: rad etilgan bron qayta yuborilmaydi (`REJECTED`),
  bog'lanmagan xona xato emas (`NOT_APPLICABLE`), birinchi polling to'liq
  va bog'lanishni kutadi, shifrlash kaliti invite code'dan oldin
  tekshiriladi, qo'lda kiritilgan OTA broni dublikat bo'lmaydi, navbat
  oynasida o'zgarish yo'qolmaydi, bog'lashdan keyin kutayotgan bronlar
  darhol yuboriladi.
