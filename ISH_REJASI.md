# Ish rejasi

**Audit sanasi:** 2026-09-25 · **Yangilandi:** 2026-09-26 (to'liq audit + Beds24 olib tashlandi)

> **2026-09-26 holati.** Egasi qarori bilan Beds24 integratsiyasi
> to'liq olib tashlandi va serverga chiqarildi ([BEDS24.md](BEDS24.md)).
> Shu sabab **B-bo'lim (B1–B9), S11, 1.1, 1.6 va Beds24/valyuta bilan
> bog'liq barcha bandlar YOPILDI — endi dolzarb emas.** S8 (Mavjudlik —
> real ma'lumot) bajarildi: `GET /api/rooms/availability`.
> 1.3 (testlar jonli bazani o'chirmasligi) bajarildi: `vitest.setup.ts`
> baza nomini, seed esa bronli bazani tekshiradi.
>
> **Hozir ochiq qolganlar** (egasi / tashqi):
> 1. Booking.com hali Beds24'ga ulangan — Beds24 tomonida uzish yoki
>    Booking.com'da sotuvni yopish; OTA bronlarini PMS'ga qo'lda kiritish.
> 2. Booking.com broni (101, 30.09–03.10) PMS'ga kiritilishi — hozircha
>    101 shu kechalar uchun yopib qo'yilgan.
> 3. Beds24 API token'ini Beds24 kabinetida o'chirish.
> 4. Serverdagi foydalanuvchi parollarini almashtirish (seed paroli ochiq repoda).
> 5. Git: 2026-09-26 o'zgarishlari commit qilinmagan; ochiq repodagi
>    tozalash fotolari va tarixdagi server IP — egasining qarori.
> 6. `minStay` sayt/qabulxona bronida tekshirilmaydi; bolalar sig'imga
>    kirishi belgilanmagan (PROJECT_LOGIC 17-bo'lim).

Bu fayl loyihada qilinishi kerak bo'lgan barcha ishlarni bir
joyga yig'adi. Manbalar: 2026-09-25 dagi to'liq kod auditi va
[TODO.md](TODO.md) dagi hali bajarilmagan bandlar. TODO.md dagi
kod bilan mos kelmagan da'volar shu yerda to'g'rilangan.

Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md)

**Tartib:** avval yetishmayotgan qismlar qo'shiladi (1-bosqich),
keyin xatolar tuzatiladi (2-bosqich), oxirida kod tozalanadi
(3-bosqich). 0-bo'lim kod ishi emas — jonli tizimdagi xavf,
shuning uchun eng oldinda turibdi. S-bo'lim (Shaxmatka, Mavjudlik,
Narxlar) 0 dan keyin turadi: uning S1–S2 qadamlari jonli bronlarni
buzayotgan xatoni to'xtatadi. B-bo'lim (Beds24 real hisobi,
2026-09-25) S dan keyin: real ulanishdan oldin bajarilishi shart.

Belgilar: **[qaror]** — boshlashdan oldin egasi yoki mijozning
qarori kerak. **[tashqi]** — kod tashqarisida bajariladi.

---

## 0. Darhol (jonli tizim xavfsizligi)

GitHub repo **ochiq (public)**. Birinchi commit tarixida server
manzili va domen qolgan. README va SERVER.md da standart login
yozilgan, serverdagi parollar esa hali o'zgartirilmagan.

- [ ] **[tashqi]** Serverdagi 4 ta hisob parolini almashtirish
      (founder, admin, manager, staff). Hozir to'rttasida ham
      `prisma/seed.ts` dagi standart parol turibdi.
- [ ] **[tashqi]** Server SSH parolini almashtirish.
- [ ] **[qaror]** Repo: private qilish yoki git tarixini
      tozalash (tarixni tozalash qaytarib bo'lmaydigan amal).
- [x] README.md va SERVER.md dan standart parolni olib tashlash
      (2026-09-25). Git tarixida qoladi — tarixni tozalash yuqoridagi
      [qaror] bandida.
- [ ] Shu faylni xavfsizlik bandlari (1.1, 1.2, 2.1) tuzatilmaguncha
      push qilmaslik — unda ochiq zaifliklar tasvirlangan.

---

## S. Shaxmatka, Mavjudlik va Narxlar

**So'rov (2026-09-25):**
1. Bandlik jadvalida bron blokini (mehmon ismi yozilgan joy)
   sichqoncha bilan surib sanani o'zgartirish mumkin — bu xavfli.
   Sana faqat bron ichidagi "Sanalarni o'zgartirish" tugmasi
   orqali o'zgarsin.
2. "Mavjudlik" bo'limi shaxmatka bilan to'liq mos kelsin, xona
   raqami va ID ko'rinsin.
3. "Narxlar" bo'limida xona narxini o'zgartirish mumkin bo'lsin
   va narx Beds24'da ham o'zgarsin.
4. Bandlik jadvalining katak chiziqlari Excel kabi aniqroq
   ko'rinsin.

### Tahlil natijasi

**1. Surish xavfli bo'lishdan tashqari sanani o'zi buzadi.**
[shaxmatka.html:154](zakas042/backend/public/app/shaxmatka.html#L154)
dagi `toKey()` sanani `toISOString()` orqali oladi. Toshkentda
(UTC+5) mahalliy yarim tun UTC bo'yicha kechagi kun soat 19:00,
shuning uchun `toKey(fromKey("2026-09-25"))` = `"2026-09-24"`
(2026-09-25 da tekshirildi). Bron blokini bosganda sichqoncha
1 piksel qimirlasa `onDragMove` ishlaydi. Siljish 0 kun bo'lsa ham
ikkala sana bir kun ertaga suriladi, `datesChanged = true` bo'ladi
va `changeDates` serverga, u yerdan Beds24'ga ketadi. Demak oddiy
bosish ham bronni bir kun ertaroqqa ko'chirishi mumkin. Blok
vertikal surilsa xona ham almashadi.

**2. `toKey()` xatosi boshqa joylarda ham bor.** Quyidagi joylar
bir kun oldingi sanani beradi:
- bo'sh katak bosilganda ochiladigan oynadagi kirish sanasi;
- "Bron qo'shish" va xona menyusidagi "Yangi bron";
- Narxlar panelining boshlang'ich oralig'i (kechadan boshlanadi);
- yangi bron uchun "bugungi narx" (aslida kechagi narx olinadi);
- toolbar'dagi sana tanlagich.

**3. Sana va xona o'zgarishi audit jurnaliga yozilmaydi**
([routes/reservations.ts:225-238](zakas042/backend/src/routes/reservations.ts#L225)).
Tasodifan surilgan bronlarning aniq ro'yxatini olib bo'lmaydi.

**4. Mavjudlik jadvali soxta.**
[admin-panel.html:5056-5149](zakas042/backend/public/app/admin-panel.html#L5056)
dagi `seededFree()` tasodifiy raqam chiqaradi. Unda 3 ta qattiq
yozilgan tarif bor (Standart 6, Ikki kishilik 4, Lyuks 2), bazada
esa 9 ta tarif bor. Eksport ham shu soxta raqamlarni yuklaydi.

**5. Shaxmatka va backend "band" ni turlicha hisoblaydi.** Shu
sabab Mavjudlik backend'dan olinsa ham shaxmatka bilan mos
kelmaydi. Avval bandlik qoidasi bitta bo'lishi kerak.

| Holat | Shaxmatka (`isRoomAvailable`) | Backend (`isRoomFree`, `Availability`) |
|---|---|---|
| `NO_SHOW` bron | band | bo'sh |
| Yopilgan kun (`RoomDayStatus`, ta'mir) | ko'rsatilmaydi, bo'sh | band |
| Faol emas xona (`isActive=false`) | ko'rinadi, bron qilsa bo'ladi | jami sondan chiqariladi, lekin undagi bron band sanaladi |

**6. Narxlar.** Admin paneldagi "Narxlar" bo'limi bo'sh
([admin-panel.html:1284-1294](zakas042/backend/public/app/admin-panel.html#L1284)).
Narx faqat shaxmatka toolbar'idagi kichik oynada (`PricingPanel`)
o'zgaradi: butun oraliqqa bitta qiymat beriladi, kunlar bo'yicha
ko'rinish yo'q. Backend zanjiri tayyor: `PUT /api/rate-plans` →
`RatePlan` → navbat → `pushRates` → Beds24
`POST /inventory/rooms/calendar` (`price1`). Kamchiliklari:
- `price: z.number().min(0)` — **0 so'm qabul qilinadi va OTA'ga
  ketadi**, ya'ni xona tekinga sotiladi. Yuqori chegara ham yo'q.
- Oraliq cheklanmagan va yozish tranzaksiyasiz: har kun alohida
  ketma-ket `upsert` qilinadi. Yarmida uzilsa narxlar aralash
  qoladi.
- `pushRates` yuborib bo'lgach oraliqdagi `syncedAt: null` bo'lgan
  hamma kunni "yuborildi" deb belgilaydi
  ([services/rates.ts:148](zakas042/backend/src/services/rates.ts#L148)).
  Yuborish paytida narx yana o'zgartirilsa, yangi narx Beds24'ga
  bormaydi, lekin "yuborildi" bo'lib ko'rinadi.
- Narx manbai (SoT) `beds24` bo'lsa PMS narxi yuborilmas edi. Panel
  esa "Beds24 orqali yuboriladi" deb yozardi va belgi doim
  "kutmoqda" holatida qolardi. **2026-09-25:** Q9 bo'yicha SoT
  `beds24` da ham narx yuboriladi, Beds24'dagisi tortiladi (B1).
- Saqlangandan keyin shaxmatkadagi `typePrices` yangilanmaydi.
  Sahifa yangilanguncha yangi bron oynasi eski narxni taklif qiladi.
- Shaxmatka `rate.sync.updated` event'ini qabul qilmaydi, shuning
  uchun sync belgisi o'zi yangilanmaydi.
- Beds24 real hisobga hali ulanmagan (B5), ya'ni narx hozir
  Beds24'ga umuman yetib bormaydi. Valyuta hal qilindi (B3: tizim USD,
  real obyekt ham USD) — ulangach narx yuboriladi.
- Narx xona bo'yicha emas, **tarif (xona turi)** bo'yicha
  belgilanadi — Beds24 ham shunday ishlaydi. "Xona narxi" deganda
  shu xona tegishli tarifning narxi tushuniladi (201 va 301 ning
  o'z tarifi bor).

**7. Katak chiziqlari.** Kataklar va qatorlar `border-gray-100`
(#f3f4f6) bilan chizilgan — oq fonda deyarli ko'rinmaydi. Tailwind
CSS oldindan yasalgan
([shaxmatka.html:7-26](zakas042/backend/public/app/shaxmatka.html#L7)),
shuning uchun yangi class qo'shilsa CSS qayta yasalmaguncha u
ishlamaydi.

### Tartib va sabab

Asosiy qoida: **avval zararni to'xtatish, keyin poydevorni
to'g'rilash (sana, bandlik qoidasi), keyin uning ustiga qurish
(Mavjudlik, Narxlar), oxirida tashqi tizimni (Beds24) tekshirish.**
Har qadam oldingisiga tayanadi. Har qadamdan keyin shu bo'lim
oxiridagi nazorat ro'yxati to'liq tekshiriladi — oldin tuzatilgan
narsa qaytib buzilmasligi uchun.

| # | Ish | Nega shu o'rinda | Qaysi qadamdan keyin |
|---|---|---|---|
| S1 | Bronni sichqoncha bilan surishni o'chirish | jonli zararni darhol to'xtatadi | — |
| S2 | `toKey()` ni tuzatish | keyingi hamma ish sana kalitiga tayanadi | S1 bilan bitta reliz |
| S3 | Surilib ketgan bronlarni topish | yangi zarar to'xtagach eskisini tozalash | S1, S2 |
| S4 | Backend: sana va xona o'zgartirish himoyasi, audit | UI cheklovi yetmaydi, API ochiq | — |
| S5 | "Sanalarni o'zgartirish" oynasi | endi sana faqat shu yerda o'zgaradi | S2, S4 |
| S6 | Excel uslubidagi chiziqlar | faqat ko'rinish; S1 tekkan kodga tegadi | S1 |
| S7 | Bandlik qoidasini bitta qilish | Mavjudlik mos kelishining sharti | S2 |
| S8 | Mavjudlik: real ma'lumot | S7 qoidasi ustiga quriladi | S7 |
| S9 | Narx: backend himoyasi | UI'dan oldin API xavfsiz bo'lsin | — |
| S10 | Narxlar bo'limi (admin panel) | S9 ustiga quriladi | S2, S9 |
| S11 | Narxni Beds24'da oxirigacha tekshirish | real ulanish kerak | B3, B5, S9 |
| S12 | Testlar | test bazasi kerak | 1.3 |
| S13 | Vaqt zonasi: qolgan joylar | kam uchraydi, lekin ko'p joyga tegadi | S2 |

S1 va S2 bitta relizda chiqadi: ikkalasi faqat `shaxmatka.html`
ni o'zgartiradi, migratsiya kerak emas.

### S1. Bronni sichqoncha bilan surishni o'chirish

**Holat:** bajarildi va serverga chiqarildi (2026-09-25). Brauzerda soxta API bilan sinaldi: eski versiyada
1 piksel qimirlagan bosish `change-dates` yuborib, bronni 26 dan
25-sentyabrga surdi; yangi versiyada hech qanday yozish so'rovi
ketmadi, tafsilot oynasi ochildi.

**Qayerda:** `shaxmatka.html` — `App` ichidagi "sichqoncha bilan
surish YO'Q" izohi, `ReservationBlock`.

- [x] `ReservationBlock` dan chap/o'ng tutqichlarni
      (`cursor-ew-resize`) va barcha `onMouseDown` larni olib
      tashlash. Blok bosilganda faqat tafsilot oynasi ochiladi
- [x] `beginDrag`, `onDragMove`, `onDragEnd`, `applyDragChange`,
      `dragRef`, `dragPreview` va ularni tozalaydigan `useEffect`
      ni o'chirish. Kod izohga olinmasin, butunlay o'chirilsin
- [x] `onOpen` dagi `!dragRef.current` shartini olib tashlash
- [x] Xona ham faqat "Xonani almashtirish" tugmasi orqali
      o'zgaradi (vertikal surish ham yo'qoladi)
- [x] `isRoomAvailable` va `availableRoomsFor` **qoladi** — ularni
      yangi bron va xona almashtirish oynalari ishlatadi
- [x] Serverga chiqarish (S2 bilan birga). Faqat `shaxmatka.html`
      yuborildi, qayta ishga tushirish kerak bo'lmadi. Eski fayl
      serverda `shaxmatka.html.bak-20260925` nomi bilan turibdi

**Tekshirish:** blokni bosib, ushlab har tomonga surish — hech
narsa o'zgarmaydi, qo'yib yuborilganda tafsilot oynasi ochiladi.
Brauzerning Network bo'limida `change-dates` / `change-room`
so'rovi yo'q.
**Buzilmasligi kerak:** bo'sh katakni bosib bron yaratish,
tafsilot oynasidagi barcha tugmalar.

### S2. Sana kalitini (`toKey`) tuzatish

**Holat:** bajarildi va serverga chiqarildi (2026-09-25). `TZ=Asia/Tashkent` da 2026-01-01 dan 2028-02-29
gacha har kun uchun `toKey(fromKey(k)) === k` tekshirildi. Brauzerda
"27 Sen" katagi bosilganda eski versiya `2026-09-26`, yangisi
`2026-09-27` berdi; toolbar sanasi va "bugungi narx" so'rovi ham
endi bugungi kunni oladi.

**Qayerda:** [shaxmatka.html:154](zakas042/backend/public/app/shaxmatka.html#L154).

- [x] `toKey` sanani mahalliy yil, oy va kundan yasasin
      (`getFullYear` / `getMonth` / `getDate`), `toISOString()`
      dan emas
- [x] Tahlilning 2-bandidagi har bir joy to'g'ri kunni berishini
      tekshirish
- [ ] Admin paneldagi `avToKey` da ham shu xato bor, lekin u S8 da
      butunlay qayta yoziladi — alohida tuzatish shart emas

**Tekshirish:** brauzer konsolida
`toKey(fromKey("2026-09-25")) === "2026-09-25"`. 25-sana bo'sh
katagi bosilganda oynada 25 chiqadi.
**Buzilmasligi kerak:** bronlar gridda o'z joyida turadi (ular
`fromKey` va `diffDays` bilan joylashadi, `toKey` ga bog'liq emas),
"bugun" ustuni ko'k bo'lib qoladi.

### S3. Surilib ketgan bronlarni topish

Sana/xona o'zgarishi `AuditLog` ga yozilmaydi, shuning uchun aniq
ro'yxat yo'q. Taxminiy yo'l bilan topiladi:

- [ ] Bazadan **faqat o'qib**, oxirgi haftalarda o'zgargan bronlarni
      ro'yxatlash: `Reservation.updatedAt` va `SyncLog` dagi bron
      yuborish yozuvlari (`reservationId` bo'yicha)
- [ ] Ro'yxatni qabulxona bilan solishtirish: mehmon aslida qaysi
      kuni keladi yoki kelgan
- [ ] Xatolarini "Sanalarni o'zgartirish" orqali qo'lda tuzatish
      (o'zgarish Beds24'ga ham ketadi)
- [ ] OTA bronlariga (Booking.com va boshqalar) alohida e'tibor:
      PMS'da surilgan bo'lsa OTA'da eski sanada qolgan bo'ladi

### S4. Backend: sana va xona o'zgartirish himoyasi

2.6 dagi `changeRoom` / `changeDates` bandlari shu yerga
ko'chirildi. UI'dagi cheklov yetarli emas — API'ni to'g'ridan-
to'g'ri chaqirish mumkin. Beds24 webhook yo'li bu funksiyalarni
ishlatmaydi, shuning uchun bu himoya sinxronizatsiyani buzmaydi.

**Qayerda:** [services/reservations.ts:500-592](zakas042/backend/src/services/reservations.ts#L500),
[routes/reservations.ts:225-238](zakas042/backend/src/routes/reservations.ts#L225).

- [ ] Status tekshiruvi: `CANCELLED`, `NO_SHOW` va `CHECKED_OUT`
      bronni ko'chirib bo'lmaydi (409 va tushunarli xabar)
- [ ] `CHECKED_IN` bronda kirish sanasi o'zgarmaydi, faqat chiqish
      sanasi o'zgaradi — mehmon allaqachon xonada
- [ ] Oraliq chegarasi: kamida 1 kecha, ko'pi bilan N kecha
      **[qaror: N]**
- [ ] Sana yoki xona o'zgarmagan bo'lsa hech narsa qilinmasin
      (bo'sh Beds24 job yaratilmasin)
- [ ] Ikkala amalga `audit()` qo'shish: eski va yangi qiymat, kim,
      qachon. S3 dagi muammo takrorlanmasligi uchun
- [x] OTA bronlari (`booking_com`, `airbnb`, `expedia`): sanani
      o'zgartirish **to'silgan** — mijoz qarori Q9 ("Beds24
      ustuvor", 2026-09-25). `changeDates` 409 `CHANNEL_OWNED`
      qaytaradi (B1). Bekor qilish, narx va boshqa turga ko'chirish
      ham to'silgan
- [ ] Test (1.3 dan keyin): har status uchun ruxsat yoki rad

### S5. "Sanalarni o'zgartirish" oynasi

S1 dan keyin sana faqat shu oyna orqali o'zgaradi, shuning uchun u
xavfsiz va tushunarli bo'lishi kerak.

**Qayerda:** [shaxmatka.html:2031-2043](zakas042/backend/public/app/shaxmatka.html#L2031)
(`ChangeDatesModal`), [shaxmatka.html:1920-1924](zakas042/backend/public/app/shaxmatka.html#L1920).

- [ ] Joriy va yangi sanalar yonma-yon ko'rinsin:
      "25 Sen → 28 Sen (3 kecha)" va "26 Sen → 30 Sen (4 kecha)"
- [ ] Yangi summa va farq: "+450 000 so'm" yoki "−450 000 so'm".
      Bronning kechalik narxi o'zgarmaydi — oynada shu aytilsin
- [ ] To'qnashuv yozish paytidayoq tekshirilsin (`isRoomAvailable`,
      bronning o'zi hisobga olinmaydi). Band bo'lsa qizil xabar
      chiqsin va "Saqlash" o'chsin
- [ ] Sana o'zgarmagan yoki chiqish sanasi kirishdan oldin bo'lsa
      "Saqlash" o'chiq
- [ ] `checked_in` bronda kirish sanasi maydoni o'chiq (S4 bilan
      bir xil qoida)
- [ ] `cancelled`, `checked_out`, `no_show` bronlarda
      "Sanalarni o'zgartirish" va "Xonani almashtirish" tugmalari
      ko'rinmaydi
- [ ] OTA bronida S4 dagi qarorga mos ogohlantirish
- [ ] Saqlashdan oldin tasdiqlash so'ralsin — tasodifan bosishdan
      himoya
- [ ] Tafsilot oynasida bron ID ko'rinsin (qisqa, nusxa olish
      tugmasi bilan)

### S6. Excel uslubidagi katak chiziqlari

**2026-09-26 (egasi talabi):** chiziqlar 2px va to'qroq rangda
(`shaxmatka.html` `<style>`: `--sx-line`, `.sx-cell`, `.sx-room`).
Quyidagi qolgan bandlar — keyingi bosqich.

**Qayerda:** [shaxmatka.html:1130-1216](zakas042/backend/public/app/shaxmatka.html#L1130).

- [ ] Vertikal va gorizontal chiziqlar bir xil aniq rangda
      (`#d1d5db` atrofida). Hozir `gray-100`
- [ ] Xona ustuni va sarlavha qatori chegarasi qalinroq bo'lsin —
      Excel'dagi muzlatilgan qator va ustun kabi
- [ ] Oy almashadigan joyda qalin vertikal chiziq bo'lsin. Dam
      olish kunlari butun ustun bo'ylab och kulrang fonda bo'lsin
      (hozir faqat sarlavhada)
- [ ] Qavatlar orasida ajratuvchi chiziq **[ixtiyoriy]**
- [ ] Sichqoncha turgan qator va ustun yengil rang bilan
      belgilansin — xodim xona va kunni adashtirmasligi uchun
      **[ixtiyoriy]**
- [ ] Ranglar Tailwind class bilan emas, `<style>` blokidagi CSS
      o'zgaruvchi bilan beriladi (`--grid-line`). Shunda
      `vendor/tailwind.css` ni qayta yasash shart emas va rang bir
      joydan sozlanadi
- [ ] Chiziq qalinligi o'zgarganda bron bloklari katakdan chiqib
      ketmasin (`marginLeft: 2`, `top-1 bottom-1`)

**Tekshirish:** zoom'ning 5 darajasida (48–140 px) va 7, 14, 30
kunlik ko'rinishda.

### S7. Bandlik qoidasini bitta qilish (shaxmatka = backend)

Mavjudlik shaxmatka bilan mos kelishi uchun ikkalasi bitta
qoidadan hisoblanishi kerak. Qoida manbai — backenddagi
`isRoomFree()`, chunki haqiqiy himoya o'sha yerda.

**Qayerda:** [shaxmatka.html:810-823](zakas042/backend/public/app/shaxmatka.html#L810),
[services/reservations.ts:125](zakas042/backend/src/services/reservations.ts#L125),
[services/availability.ts:71](zakas042/backend/src/services/availability.ts#L71).

- [ ] Shaxmatka `isRoomAvailable` `no_show` bronni band deb
      hisoblamasin (backenddagi kabi)
- [ ] Shaxmatka yopilgan kunlarni `GET /api/rooms/blocks` dan
      yuklasin (endpoint tayyor), ularni kulrang, chiziqli katak
      qilib ko'rsatsin va `isRoomAvailable` ularni band deb
      hisoblasin
- [ ] `availability.changed` event'i kelganda (xona yopilganda
      yoki ochilganda shu keladi) yopiq kunlar qayta yuklansin.
      Hozir shaxmatka bu event'ni qabul qilmaydi
- [ ] Faol emas xonalar (`isActive=false`) shaxmatkada
      ko'rinmasin. `createReservation` va `changeRoom` ham ularni
      rad etsin
- [ ] `recalcAvailability` band bronlarni sanaganda faqat faol
      xonalarni olsin

**Buzilmasligi kerak:** yangi bron oynasidagi "Xona to'qnashuvi"
ogohlantirishi va 409 xatolari.

### S8. Mavjudlik bo'limi — real ma'lumot

**Qayerda:** [admin-panel.html:5056-5149](zakas042/backend/public/app/admin-panel.html#L5056)
(soxta kod), [admin-panel.html:1263-1283](zakas042/backend/public/app/admin-panel.html#L1263)
(HTML), yangi endpoint.

Backend:
- [ ] `GET /api/availability/grid?from=&to=` (`reservation.read`
      huquqi, ko'pi bilan 62 kun). Har tarif uchun: tarif ID, nomi,
      Beds24 room ID (mapping'dan), jami xona soni va har kun uchun
      bo'sh, band va yopiq xonalar soni hamda Beds24'ga oxirgi
      yuborilgan son (`syncedCount`). Har xona uchun: raqami va
      har kunning holati — bo'sh, band (bron ID va mehmon) yoki
      yopiq
- [ ] Hisob S7 qoidasi bilan, jonli ma'lumotdan qilinadi (bronlar
      va `RoomDayStatus`), `Availability` kesh jadvalidan emas.
      Shunda shaxmatka bilan to'liq mos keladi
- [ ] Hamma ma'lumot bir-ikkita so'rovda olinsin, har xona uchun
      alohida so'rov (N+1) bo'lmasin — `/api/rooms/available` dagi
      kabi

Frontend:
- [ ] `seededFree` va `AV_TARIFFS` ni butunlay o'chirish
- [ ] Backenddan kelgan 9 tarif ko'rsatilsin. Har tarif ostida
      ochiladigan xona qatorlari bo'lsin ("101"), band katak
      ustiga sichqoncha borganda bron ID va mehmon ko'rinsin
- [ ] Band katak bosilganda shaxmatkada o'sha bron ochilsin
      **[ixtiyoriy]**
- [ ] PMS'dagi son Beds24'ga yuborilgan sondan farq qilsa, katakda
      ogohlantirish belgisi chiqsin — farq ko'rinib tursin
- [ ] `reservation.*` va `availability.changed` event'lari
      kelganda jadval o'zi yangilansin (admin WebSocket'i tayyor)
- [ ] CSV eksport real raqamlarni yuklasin
- [ ] Sana funksiyalari S2 dagi to'g'ri `toKey` bilan

**Tekshirish:** bir kun uchun Mavjudlik'dagi bo'sh xonalar soni
shaxmatkadagi o'sha tarif xonalarining bo'sh kataklari soniga teng.
Bron yaratilsa, bekor qilinsa yoki xona yopilsa ikkalasi birga
o'zgaradi.

### S9. Narx: backend himoyasi

UI qurilishidan oldin qilinadi: noto'g'ri narx OTA'ga ketsa pul
yo'qotiladi.

**Qayerda:** [routes/rates.ts:40-81](zakas042/backend/src/routes/rates.ts#L40),
[services/rates.ts:87-163](zakas042/backend/src/services/rates.ts#L87).

- [ ] Narx 0 dan katta va `MAX_PRICE` dan oshmasin (bronlardagi
      50 mln bilan bir xil). Hozir 0 qabul qilinadi
- [ ] Oraliq ko'pi bilan 366 kun, `from` o'tgan kun bo'lmasin
- [ ] Hamma yozuv bitta tranzaksiyada bo'lsin, ketma-ket `upsert`
      o'rniga birga yozilsin
- [ ] Hafta kunlarini tanlash imkoniyati (masalan
      `weekdays: [5, 6]` — faqat juma va shanba). S10 dagi dam
      olish kuni narxi uchun kerak
- [x] `pushRates` poygasini yopish: faqat haqiqatan yuborilgan
      (sana, narx) juftligi "yuborildi" deb belgilanadi (B1 bilan
      birga, 2026-09-25)
- [ ] SoT `beds24` ma'nosi o'zgardi (Q9): admin narxi Beds24'ga
      yoziladi, Beds24'dagisi soatlik tortiladi va ustuvor. GET va PUT
      javobi shuni va "valyuta mos emas" holatini aytsin (B7)
- [ ] Katta o'zgarishda tasdiqlash: yangi narx joriydan X% dan
      ko'p farq qilsa `confirm: true` talab qilinsin
      **[qaror: X]**
- [ ] Test (1.3 dan keyin)

### S10. Narxlar bo'limi (admin panel)

**2026-09-26 — asosiy qismi bajarildi** (admin panel → Shaxmatka →
Narxlar): har xona raqami, ID'si, kategoriyasi va Beds24 bog'lanishi;
katakni bosib kunlik narx (kategoriyaning hamma xonasiga); mavsumiy
narx — oraliq + hafta kunlari + kategoriyalar, tasdiqlash oynasi bilan
(`PUT /api/rate-plans` `weekdays`); $ ekvivalenti va Beds24 holati (●).

**Qayerda:** [admin-panel.html:1284-1294](zakas042/backend/public/app/admin-panel.html#L1284)
(hozir bo'sh), shaxmatkadagi `PricingPanel`
[shaxmatka.html:1473-1626](zakas042/backend/public/app/shaxmatka.html#L1473).

- [ ] Jadval: qatorlarda 9 tarif (nomi va ID), ustunlarda kunlar
      (14 yoki 30). Har katakda narx va sync belgisi: ● yuborildi,
      ○ kutmoqda, ⚠ xato va ↻ qayta yuborish
- [ ] Katakni bosib tahrirlash, Excel kabi: Enter — saqlash,
      Esc — bekor qilish
- [ ] Ommaviy o'zgartirish: tariflar, oraliq, hafta kunlari va
      narx tanlanadi
- [ ] Saqlashdan oldin nima o'zgarishi ko'rsatilsin ("3 tarif ×
      30 kun, 450 000 → 500 000") va tasdiqlash so'ralsin
- [ ] Narx qaysi sanagacha belgilangani ko'rinsin (1.4 bilan
      bog'liq)
- [ ] `rate.sync.updated` event'i kelganda belgilar o'zi
      yangilansin
- [ ] `rate.write` huquqi yo'q rol jadvalni faqat ko'ra olsin
- [ ] Shaxmatkadagi `PricingPanel`: saqlangandan keyin
      `typePrices` yangilansin. **[qaror]** Keyinchalik u
      "Narxlar bo'limida ochish" havolasiga almashtirilsinmi —
      narx ikki joyda ikki xil usulda tahrirlanmasligi uchun
- [ ] Bitta xonaga alohida narx kerak bo'lsa, unga alohida tarif
      ochiladi (Beds24'da ham alohida room). Bu jadvalda shunday
      tushuntirish yozilsin

### S11. Narxni Beds24'da oxirigacha tekshirish

**Talab:** B5 bajarilgan bo'lishi kerak (real ulanish, 9 tarif
mapping'i, `isComplete: true`) va S9 tugagan bo'lishi kerak (B3 hal
qilindi).

- [x] Beds24 mulkining valyutasi tekshirildi (2026-09-25): **USD**,
      egasi tasdiqladi. PMS ham USD (B3, Q13). Valyuta tekshiruvi
      himoya sifatida qoldi
- [ ] **[tashqi]** Beds24'da xonalar kunlik narx (`price1`)
      bilan ishlashi va Booking.com ulanishi narxni shu yerdan
      olishi — Beds24 sozlamasida tekshiriladi
- [ ] Sinov: bitta tarifning uzoq kelajakdagi (masalan, 3 oydan
      keyingi) bitta kunining narxini o'zgartirish. Keyin admin
      panelda ● belgisi, Beds24 kalendarida yangi narx va
      Booking.com extranet'ida yangi narx ko'rinishini tekshirish.
      Oxirida asl narxni qaytarish
- [ ] Xato holatini (⚠ va ↻) `mock-beds24` da sinash — jonli
      mapping'ga tegilmaydi
- [ ] `sync-log` da `push_rates` SUCCESS yozuvi bor va kredit sarfi
      me'yorida

### S12. Testlar

1.3 bajarilgandan keyin.

**2026-09-25 holati.** Backend testlari birinchi marta jonli bazaga
tegmasdan, vaqtinchalik mahalliy baza klasterida ishga tushirildi
(usul: `zakas042/README.md`, "Testlar"). O'zgarishdan oldingi kod
(HEAD) ham xuddi shu muhitda sinaldi va 36 ta test ikkala kodda
AYNAN bir xil yiqildi — B1 dan oldingi eskirgan testlar. Hammasi
tuzatildi (kod emas, testlar eskirgan edi):

| Fayl | Edi | Sabab | Tuzatish |
|---|---|---|---|
| `mapping.test.ts` | 8 | 12 xona / 3 tur (6/4/2) kutilardi | 9 tarif juftligi, sonlar bazadan |
| `queue.test.ts` | 4 | "106", "110", "112" xonalari; echo testi 2026-09-16 qoidasiga zid | xonalar bazadan; echo ikki testga bo'lindi |
| `reconciliation.test.ts` | 2 | narx 100/200 so'm — tarifdan past, 400 | `tariffFor()` |
| `availability.test.ts` | 1 | standart turda 6 xona kutilardi, endi 1 | 3 xonali tur, soni bazadan |
| `api.test.ts` | 1 | testning o'zi `tariffFor("999")` da yiqilardi | narx qo'lda |
| `public.test.ts` | 1 | sayt broni nonushta bilan, kutilma nonushtasiz | nonushta qo'shildi |
| `realtime.test.ts` | 19 | eski "standard" tur ID'si bilan mapping | 9 tarif juftligi; narx/telefon |

Qo'shimcha: `beds24Real.test.ts` (yangi, 12 test), `security.test.ts`
ga admin endpoint'lari 401/403 testi, `AUTH_REQUIRED=true` rejimida
yiqilgan 2 ta RBAC testi (FOUNDER huquqi, eski tur ID'si) tuzatildi,
`reservationSync.test.ts` sanalari har yurishda boshqa (realistik mock
band sanaga bron yaratmaydi).

**Natija:** 15 fayl, 393 test — ikkala rejimda (`AUTH_REQUIRED`
false va true) ham o'tadi.

- [x] Yuqoridagi 36 testni hozirgi 18 xona / 9 tarifga moslash

- [ ] `toKey` / `fromKey` Toshkent vaqtida (`TZ=Asia/Tashkent`)
      sanani o'zgartirmasdan qaytarishi
- [ ] `changeDates` / `changeRoom`: har status, `checked_in` da
      kirish sanasi, audit yozuvi
- [ ] `GET /api/availability/grid` natijasi `isRoomFree` bilan
      bir xil (tasodifiy oraliqlarda solishtirish)
- [ ] Narx: 0, yuqori chegara, oraliq chegarasi va yuborish
      paytidagi o'zgarish (poyga)

### S13. Vaqt zonasi — qolgan joylar

Past ustuvorlik: xato faqat 00:00–05:00 oralig'ida chiqadi, lekin
tuzatish ko'p joyga tegadi.

- [ ] Admin panelda 8 joyda `new Date().toISOString().slice(0, 10)`
      bor — tunda kechagi kunni beradi
- [ ] Backenddagi `todayUtc()` va "bugun" hisoblari UTC bo'yicha
      ishlaydi. **[qaror]** Mehmonxona kuni Asia/Tashkent bo'yicha
      hisoblansinmi
- [ ] Hammasi uchun bitta umumiy `hotelToday()` yordamchi funksiya

### Shaxmatka nazorat ro'yxati

Har qadamdan keyin va har relizdan oldin qo'lda tekshiriladi:

1. Bo'sh katak bosilsa oynada aynan o'sha kun chiqadi
2. Yaratilgan bron gridda to'g'ri kun va xonada turadi, Mavjudlik'da
   bo'sh xonalar soni 1 taga kamayadi
3. Bron blokini bosib, ushlab surganda hech narsa o'zgarmaydi,
   tafsilot oynasi ochiladi
4. "Sanalarni o'zgartirish" band sanaga o'tkazmaydi, bo'sh sanaga
   o'tkazadi, summa yangilanadi
5. "Xonani almashtirish" faqat bo'sh xonalarni taklif qiladi
6. To'lov qo'shish, bekor qilish, kirish va chiqish ishlaydi
7. Bekor qilingan bron gridda yo'qoladi, Mavjudlik'da bo'sh soni
   oshadi
8. Ikkinchi brauzer oynasida o'zgarish real vaqtda ko'rinadi
9. `npx tsc --noEmit -p tsconfig.test.json` xatosiz o'tadi
10. Brauzer konsolida xato yo'q

---

## B. Beds24 — real hisobga moslashtirish

**So'rov (2026-09-25):** egasi real Beds24 hisobiga API kalit berdi.
Shartlar: API orqali faqat o'qib o'rganish, hech narsaga tegmaslik,
**ruxsatsiz tizimga ulamaslik**. Loyiha Beds24'ga to'liq mos
kelishi kerak.

**Egasining javoblari (2026-09-25):**
- Obyekt ma'lumotlarini egasi to'ldiradi.
- Beds24'dagi **USD to'g'ri**. Keyin qaror: butun tizim USD (B3, Q13).
- Beds24'da hozir **2 ta sinov xonasi**. Rasmiy ishga tushmagan.
- Narxlarni admin o'zgartiradi.
- Bron OTA'dan tashqari **sayt va admin** tomonidan ham qo'yiladi.
- **"Beds24 tanlovi doim ustuvor"** (mijoz qarori Q9).
- Arxitektura: Booking.com, ETG/Ostrovok → Beds24 (markaziy) →
  API v2 (token) → Shaxmatka backend → Shaxmatka UI. Boshqaruv
  Shaxmatkadan ([BEDS24.md](BEDS24.md) 1-bo'lim).

**Ma'lumotnoma:** [BEDS24.md](BEDS24.md). Kalit repoda saqlanmaydi.

### B1. Real API'ga moslashtirish — bajarildi (2026-09-25)

Real hisob faqat `GET` bilan o'rganildi. Kodda 19 ta nomuvofiqlik
topildi, hammasi tuzatildi. Ro'yxat va sabablari:
[CHANNEL_MANAGER_SPEC_AND_ANALYSIS.md](CHANNEL_MANAGER_SPEC_AND_ANALYSIS.md)
3-bo'lim.

- [x] Refresh token almashishi saqlanadi, parallel yangilash bittaga
      birlashadi (`beds24/auth.ts`)
- [x] Refresh token bilan ulanish: `npm run beds24:connect -- --refresh-token`
- [x] `/properties?includeAllRooms=true`, obyekt valyutasi
- [x] Unit mapping xona turi bilan birga qidiriladi; `autoMapUnits`
      va `POST /api/admin/mapping/auto-units`
- [x] Polling: hamma statuslar, sahifalash, `includeInvoiceItems`
- [x] Kalendar: `include*` bayroqlari, oraliqlarni kunlarga yoyish
- [x] Webhook v2 formati: `event`siz, to'lovlar yuqori darajada,
      `channel`/`apiReference`/`country2`
- [x] Status: check-in/out bayroq bilan, NO_SHOW = `cancelled` +
      `noShow`, `black` va `inquiry` bron emas, `new` = CONFIRMED
- [x] Q9: `SOURCE_OF_TRUTH_*` standarti `beds24`; bo'sh joy sonini
      PMS yozmaydi; narx write-through + soatlik `pullRates`
- [x] Yangi bron Beds24'ga `checkAvailability` bilan — joy bo'lmasa
      rad etiladi, admin xabar oladi
- [x] OTA broni: PMS narx, sana, mehmon, status va `referer`ni
      Beds24'da o'zgartirmaydi; PMS'da bekor qilish, sana, narx,
      boshqa turga ko'chirish 409 `CHANNEL_OWNED`
- [x] Beds24 "confirmed" xonadagi mehmonni CONFIRMED ga
      qaytarmaydi; bekor qilish kelsa-yu mehmon xonada bo'lsa admin
      ogohlantiriladi
- [x] Avtomatik bekor qilish faqat sayt broniga (OTA `request`
      broni bekor qilinib Beds24'ga ketardi)
- [x] Valyuta tekshiruvi: mos kelmasa narx yuborilmaydi/olinmaydi,
      bron narxsiz yuboriladi (`PMS_CURRENCY`)
- [x] Mock server real xatti-harakatga keltirildi (42 test)
- [x] `beds24:verify`: scope, valyuta, SoT, unit mapping tekshiruvi
- [x] Echo himoyasi toraytirildi: `referer: "PMS"` bronga kelgan
      webhook faqat PMS holatidan HECH NARSA farq qilmasa tashlanadi.
      Real Beds24 API yozuvlariga webhook yubormaydi — bunday webhook
      odatda Beds24 panelidagi o'zgarish va u qo'llanishi kerak (Q9)
- [x] Bron narxi Beds24'ga faqat bron valyutasi PMS valyutasiga ham,
      Beds24 valyutasiga ham teng bo'lsa ketadi (eski "USD" yorliqli
      so'mdagi qatorlar — B3)
- [x] Kredit "tugagan" holati eskirsa: 30 s da bitta sinov so'rovi.
      Ilgari bitta 429 dan keyin 5 daqiqagacha hech bir so'rov
      ketmasdi, kredit tiklangan bo'lsa ham (`client.ts`)
- [x] Yuborish o'rtasida jarayon o'lsa (deploy, restart) bron `SYNCING`
      da abadiy qolardi — har keyingi yuborish "boshqa jarayon
      yubormoqda" deb rad etilar, catch-up esa uni ko'rmasdi. Endi
      2 daqiqadan eski band qilish qayta olinadi, catch-up 5 daqiqadan
      eski `SYNCING` ni ham yuboradi (`reservationSync.ts`)

**Tekshiruv:** `npx tsc --noEmit -p tsconfig.test.json` toza. Mock
42/42. Backend testlari **jonli bazaga tegmasdan** vaqtinchalik
mahalliy baza klasterida (usul: `zakas042/README.md`, "Testlar"):
389 dan 353 o'tdi, shu jumladan yangi `beds24Real.test.ts` (11/11 —
yuqoridagi xatolar qaytmasligi). Yiqilgan 36 tasi o'zgarishdan
oldingi kodda ham aynan shunday yiqiladi — S12.

**Serverga chiqarilmagan.** Chiqarishda (`tools/sync.sh restart`):
- Backend va mock birga yuborilsin: yangi mock refresh token'ni har
  safar almashtiradi, eski backend buni saqlay olmaydi.
- Server mock USD qaytaradi; PMS ham USD (B3) — mos. B2/B3 bilan
  birga chiqariladi: [SERVER.md](SERVER.md) "USD ga o'tish".
- Server `.env` da `SOURCE_OF_TRUTH_*` yozilgan bo'lsa o'sha ishlaydi.
  Q9 bo'yicha ikkalasi `beds24` bo'lishi kerak.
- OTA bronini Shaxmatkada bekor qilish endi 409 qaytaradi (B7 da UI).
- Seed'dan keyin `npm run beds24:mock` endi xonalarni unitlarga ham
  bog'laydi.

### B2. Migratsiya to'plami — tayyor, serverga qo'llash egasida (2026-09-25)

Egasi: "Migratsiya ruxsat", "Tayyorlab qo'ying" (deploy'ni o'zi qiladi).
Migratsiya `20260925035411_usd_origin_channel_block` izolyatsiyalangan
test bazasida yaratildi va qo'llandi (jonli bazaga tegilmadi). Server
tartibi: [SERVER.md](SERVER.md) "USD ga o'tish" (zaxira -> migrate
deploy -> build -> tozalash skripti -> tekshiruv, orqaga qaytarish bilan).

- [x] `ReservationSource.OSTROVOK` (ETG) — `toSource` kanal kodidan
      (`ostrovok*`, `etg`), Shaxmatka, admin panel, bot, oshxona nomlari
- [x] `Reservation.externalReference` — OTA bron raqami (Shaxmatka bron
      oynasida ko'rinadi; izohdagi `[Booking.com #...]` ham qoldi)
- [x] `Reservation.origin` (`PMS` | `CHANNEL`) — egalik qoidasi shu
      maydondan (`lib/channelOwnership.ts`), Beds24'ga yuborish rejimi
      ham (`pushModeFor`). Eski qatorlar uchun backfill SQL migratsiyada
- [x] `ChannelBlock` — ikki yo'nalish ([BEDS24.md](BEDS24.md) 2-bo'lim,
      "Xona yopish"): PMS yopishi -> Beds24 `black` bron (diff, qulf,
      catch-up), Beds24 `black` -> PMS kunlari, Beds24 yopgan kunni PMS
      ocholmaydi (409). 8 test (`channelBlocks.test.ts`)
- [x] `pricePerNight` DECIMAL(12,4) — OTA jami narxi sentigacha tiklanadi
- [x] `Reservation.currency` standarti USD
- [x] Serverga qo'llandi — 2026-09-25, egasining so'rovi bilan (SERVER.md)

### B3. Valyuta — yakuniy: so'm + Beds24 dollarda (Q15, 2026-09-25)

**Q15 (kechqurun) Q13 ni almashtirdi.** USD kodi serverga chiqqach sayt
so'm narxlarni "$600 000" deb ko'rsatdi. Egasi: "faqat Beds24'dan kelgan
bronlar dollarda va tagida so'm bilan ko'rinsin, qolgan hammasi so'mda;
dollar chet ellik mehmonlar uchun". Bajarildi: Markaziy bank kursi
(avtomatik + qo'lda), bronga kurs yoziladi, dollar bronda so'mda to'lov,
narx Beds24'ga kurs bilan, hisobot so'mda — BEDS24.md 6-bo'lim,
SERVER.md "Valyuta". Testlar: `currency.test.ts`, `money.test.ts`,
`rates.test.ts` (ikki rejimda 432/432).

Quyidagi Q13 davri yozuvi — tarix (formula qismi o'z kuchida):

Egasi: "Valyuta USD", "shaxmatka ham umuman hammasi tizimimizda USD da
bo'lsin". Eski so'mdagi ma'lumot — test, tozalanadi (aylantirilmaydi).
Ikki valyuta varianti (`ExchangeRate`, `Payment.currency`) kerak emas.

- [x] Yagona pul formulasi [lib/money.ts](zakas042/backend/src/lib/money.ts):
      sentda qo'shish, 2 xona, bron = xona + nonushta + xizmat, bekor =
      jarima. Serializer, to'lov chegarasi, sayt, "bronimni tekshirish",
      hisobot, statistika, bot, komissiya — hammasi shundan (13 unit test)
- [x] Hisobot tuzatishlari: nonushta va jarima daromadda; xizmatlar
      qo'shilgan sanasi bo'yicha (ikki oyda takrorlanmaydi); qarz — bron
      qoldig'i; boshqa davr to'lovlari olinmaydi; ADR/RevPAR sentgacha
- [x] Komissiya bazasi: xona + nonushta (mehmonxona xizmatlarisiz)
- [x] Jarima faqat PMS bronida (`origin`) — ilgari `channelId` bo'yicha
      Beds24'ga yuborilgan HAR bron jarimasiz edi
- [x] "Tarifdan past" — butun oraliq tarifi bilan (ilgari kirish kuni)
- [x] Sayt narxi: har kecha o'z tarifi, sentda (`stayPriceFromRates`)
- [x] Zod chegaralari USD da, sentgacha ([lib/moneySchema.ts](zakas042/backend/src/lib/moneySchema.ts))
- [x] `PMS_CURRENCY` standarti USD (`config.ts`, `.env.example`)
- [x] Nonushta: standart 0 = "belgilanmagan" (25 000 so'm $25 000 bo'lib
      ketmasin), admin panel -> Oshxona -> "Nonushta narxi", faol
      bronlarga qo'llash tanlovi (`services/mealPrice.ts`,
      `GET/PUT /api/admin/meal-price`)
- [x] Nonushta bronga keyin yoqilsa narxi ko'chiriladi
- [x] Formatlovchilar USD: Shaxmatka `money` (+ `resMoney`, nonushta
      qatori, qaytarish), admin `fmtMoney`/`parseMoney`, sayt
      `formatPrice` (6 til), bot `money`/`moneyShort`, xato xabarlari
- [x] Seed narxlari USD; `scripts/reset-test-data.ts` (`npm run data:reset`)
      — izolyatsiyalangan bazada sinaldi
- [x] Testlar: `money.test.ts`, `usd.test.ts` (to'lov sentlari, nonushta
      narxi o'zgarishi, jarima, hisobot davrlari)

### B4. Beds24 paneli **[tashqi — keyinroq Beds24 tomonidan sozlanadi]**

Egasi (2026-09-25): "keyinroq Beds24 tomonidan sozlanadi".

- [ ] Obyekt: nom, manzil, telefon
- [ ] 9 xona turi, `qty` = PMS'dagi xona soni, unit nomi = xona
      raqami ("101")
- [ ] Narxlar kamida 365 kun oldinga (narxsiz kun yopiq)
- [ ] ETG/Ostrovok kanalini ulash
- [ ] Webhook (ulash kuni): `twoWithPersonalData` + URL

### B5. Real hisobga ulash **[egasining ruxsati bilan]**

Ilgari 1.6 edi. Talab: B2 serverga qo'llangan, B4 bajarilgan (B3
hal qilindi; 1.1 va 1.2 yopilgan — mapping sahifalari token bilan,
admin endpoint'lari auth bilan).

- [ ] `.env`: `BEDS24_BASE_URL="https://beds24.com/api/v2"`,
      `SOURCE_OF_TRUTH_*="beds24"`
- [ ] `BEDS24_REFRESH_TOKEN=... npm run beds24:connect -- --refresh-token <property-id>`
      (kalit 30 kun ishlatilmasa o'ladi — muddati o'tgan bo'lsa
      Beds24 panelidan yangisi olinadi)
- [ ] `/admin/mapping` — 9 tarif; `POST /api/admin/mapping/auto-units`
- [ ] `npm run beds24:verify` — hammasi OK
- [ ] Beds24 panelida webhook URL

### B6. Real hisobda sinovlar

[BEDS24.md](BEDS24.md) 9-bo'lim, T1–T8. Uzoq kelajakdagi sana va
sinov xonasida, har biridan keyin qaytarib.

- [ ] T1–T2: sayt broni va band sanaga ikkinchi bron (`checkAvailability`)
- [ ] T3: `request` status joy band qiladimi
- [ ] T4: check-in/out bayrog'i Beds24 kalendarida
- [ ] T5: Beds24 panelidagi narx PMS'ga keladi
- [ ] T6–T7: Booking.com sinov broni va bekor qilish
- [ ] T8: bir kunlik kredit sarfi
- [ ] T9–T10: xona yopish ikki yo'nalishda (`black`)

### B7. Interfeys

- [x] Shaxmatka: OTA bronida "Bekor qilish" va "Sanalarni
      o'zgartirish" yashirilgan, o'rniga "Booking.com orqali kelgan
      bron..." izohi; "Xonani almashtirish" faqat shu turdagi xonalar.
      Qoida serverdan keladi (`channelOwned`, `lib/channelOwnership.ts`)
      — backend bilan bitta joy (2026-09-25)
- [x] Shaxmatka: bron summalari bronning o'z valyutasida — $75 lik
      OTA broni ilgari "75 so'm" bo'lib ko'rinardi (`money(v, currency)`)
- [x] OTA nomi va bron raqami tafsilotda ko'rinadi (manba belgisi +
      `externalReference` qatori, B2)
- [x] `mapping.html`: "Xonalarni avtomatik bog'lash" tugmasi va
      "Xona ↔ unit" holati (`unitsLinked`)
- [x] `connection.html`: narx/mavjudlik SoT, PMS va Beds24 valyutasi,
      mos kelmasa ogohlantirish; ulash ko'rsatmasida refresh token usuli
- [ ] Narxlar paneli (Shaxmatka): "Beds24 ustuvor" izohi. "Valyuta mos
      emas" hozir ⚠ belgisi va `syncError` matnida ko'rinadi
- [x] Beds24 `black` (xona yopildi) — PMS kunlari o'zi yopiladi (B2);
      unit bog'lanmagan yoki shu kunlarda bron bo'lsa `NEEDS_MANUAL_ACTION`
- [x] USD: Shaxmatka yangi bron oynasi — oraliq tarifi, nonushta qatori,
      `$` kiritish (0.01 qadam); bron oynasi — nonushta, jarima, qaytarish

### B8. Keyingi yaxshilashlar

- [ ] Sayt bronida Beds24'dan joyni oldindan so'rash (1 kredit) —
      rad etilish ehtimoli kamayadi
- [ ] Max stay, yopiq kun, kelish/ketish taqiqi (TZ 10-band)
- [ ] Webhook `customHeader` tekshiruvi — qo'shimcha himoya

### B9. Real hisob tahlili — xatolar va qolgan ishlar (2026-09-26)

Real hisob faqat o'qib tekshirildi (GET). Batafsil:
[BEDS24.md](BEDS24.md) 11-bo'lim. Hozir Beds24'da 2 ta sinov xonasi
bor (Room 1 = 101, Room 2 = 102). Egasi: **18 xonaning hammasi
keyin qo'shiladi** — Beds24 sozlamasiga oid ishlar o'shanda bir marta
qilinadi. Beds24'da har xona alohida "Room N" (qty 1) — B4 dagi
"9 xona turi" rejasi o'rniga.

**Hozir — PMS xatolari (xona soniga bog'liq emas):**

- [ ] **[qaror]** PMS'da Beds24 bronlari yo'q. PMS bronlari
      o'chirilgach Beds24'dagi haqiqiy bronlar qaytmadi (polling
      faqat o'zgarganlarni oladi): Booking.com broni 101, 30.09–03.10
      va 102 dagi bron 27.09 gacha. Sayt shu kunlarni sotishi mumkin.
      Yechim: `lastPullAt` ni orqaga surib qayta tortish (Beds24'dan
      faqat o'qiladi)
- [ ] **[qaror]** Saytdan 102 ga 26–30.09 bron tushgan — Beds24'da
      26.09 band, Beds24 rad etdi. PMS'da `CONFIRMED` / sync `FAILED`
      bo'lib turibdi. Egasi: sinov bo'lsa Shaxmatkadan bekor qilish
- [ ] Catch-up rad etilgan bronni har 15 daqiqada qayta yuboradi
      (har safar Beds24 krediti ketadi). Beds24 "joy yo'q" desa qayta
      urinmaslik: `NEEDS_MANUAL_ACTION` + admin xabari
- [ ] Sayt bronni Beds24 javobini kutmay tasdiqlaydi — Beds24 rad
      etsa ham bron PMS'da tasdiqlangan qoladi. B8 dagi "oldindan
      so'rash" bandi shuni yopadi
- [ ] Chiqish soati (`CHECKOUT_HOUR`, standart 12:00) uchun
      interfeys yo'q — Tizim nazorati sozlamalariga qo'shish.
      Tozalash xabari shu soatda ketadi

**18 xona qo'shilganda (Beds24 sozlanganda):**

- [ ] **[tashqi]** Beds24'da har xona: nom, sig'im PMS bilan bir xil.
      Hozir farq: Room 2 — 2 kishi, PMS 102 (standard3) — 3 kishi
- [ ] Hamma 18 xonani bog'lash (xona darajasida, 101/102 kabi)
- [ ] **[qaror]** Narx modeli: Beds24'da narx xona bo'yicha, PMS'da
      kategoriya bo'yicha. PMS narxi kategoriyaning hamma xonasiga
      yoziladi (tayyor). Beds24 panelidagi narx PMS'ga tortilmaydi —
      `pullRates` faqat kategoriya bog'lanishini ko'radi
- [ ] **[qaror]** Birinchi narx yuborish — Narxlar'ga haqiqiy narxlar
      kiritilgandan keyin (hozir namuna: 400–800 ming so'm, Beds24'da
      $150–200)
- [ ] **[qaror]** Minimal kecha: Beds24'da sozlanadi (Room 1 — 3 kecha).
      PMS saytida tekshirilmaydi — saytda ham shu qoida kerakmi
- [ ] **[qaror]** Chiqish vaqti bir xil bo'lsin: Beds24 obyektida
      10:00, PMS'da 12:00
- [ ] **[tashqi]** Beds24 panelida webhook URL. Hozir webhook
      kelmayapti — yangi OTA bron 15 daqiqagacha kechikadi
- [ ] Real sinovlar T1–T10 (B6)
- [ ] Qo'shimcha xizmatlar (`invoiceItems` `charge`) va mehmonlar
      ro'yxati (`guests`) olinmaydi — kerak bo'lsa qo'shish

**Bajarildi (2026-09-26, serverda):**

- [x] Narx xona bog'lanishi orqali ham yuboriladi (`rateTargets`)
- [x] Narx bilan `minStay` yuborilmaydi — Room 1 dagi "kamida 3
      kecha" 1 ga tushib ketardi
- [x] Booking.com mehmon xabari (`apiMessage`) va kelish vaqti izohga
- [x] Tozalash xabari: chiqish kuni 12:00 dan keyin; yashash
      boshlangan bron Shaxmatkadan yoki Beds24'dan bekor qilinsa

---

## 1-bosqich. Kerakli o'zgarishlar

Tizim to'liq ishlashi uchun yetishmayotgan qismlar.

### 1.1 Mapping, ulanish va sync-log sahifalari token bilan ishlashi

**Qayerda:** [public/admin/mapping.html:78](zakas042/backend/public/admin/mapping.html#L78),
`connection.html`, `sync-log.html`.

**Muammo:** uchala sahifa `fetch()` ga `Authorization` sarlavhasini
qo'shmaydi. `AUTH_REQUIRED=true` bo'lganda mapping saqlash, ulanish
tekshiruvi, sync-log va webhook'ni qayta ishlash 401 qaytaradi.
Admin panelda faqat mapping *holati* bor, tahrirlash yo'q —
demak Beds24'ga real ulanish (B5) bloklangan.

- [x] Sahifalar `localStorage` dagi `pms_token` ni yuboradi, token
      yo'q yoki 401 bo'lsa admin panelga (login) havola chiqadi —
      umumiy `public/admin/_shared.js` (2026-09-25)
- [ ] Yoki mapping tahrirlashni admin panelning "Kanal" bo'limiga
      ko'chirish (uzoq muddatda to'g'riroq yo'l)

### 1.2 Ochiq admin endpoint'lariga auth qo'shish

**Qayerda:** [routes/admin.ts:101-373](zakas042/backend/src/routes/admin.ts#L101),
[server.ts:115](zakas042/backend/src/server.ts#L115).

**Muammo:** `requireAuth` siz: `GET /api/admin/mapping`,
`/mapping/health`, `/mapping/external`, `/connection`,
`/webhook-events`, `/webhook-events/stats`, `/rates`, `/status`,
`/settings` va `/api/admin/queues`. `mapping/external?refresh=true`
Beds24 API'ni chaqiradi — begona odam kreditni (100 / 5 daqiqa)
tugatib, sinxronizatsiyani to'xtatib qo'yishi mumkin.

- [x] Har biriga `requireAuth` + mos huquq: o'qish `synclog.read`,
      Beds24'ni chaqiradigan `mapping/external` — `mapping.write`
      (2026-09-25)
- [x] `/api/admin/queues` ham `requireAuth` + `synclog.read`
      (`server.ts` da qoldi, ko'chirish shart bo'lmadi)
- [x] `security.test.ts`: 10 endpoint tokensiz 401, STAFF 403,
      ADMIN 200 — `AUTH_REQUIRED=true` bilan sinaldi

### 1.3 Testlar jonli bazani o'chirmasligi

**Qayerda:** [vitest.setup.ts:107](zakas042/backend/vitest.setup.ts#L107).

**Muammo:** himoya faqat host "localhost" ekanini tekshiradi.
Lokal `.env` dagi `localhost:5433` esa SSH tunnel orqali
serverdagi jonli baza. Tunnel ochiq holda `npm test` production
bazani qayta seed qiladi (barcha bronlar o'chadi).

- [ ] Himoya baza NOMINI tekshirsin (masalan `_test` bilan
      tugashi shart), host'ni emas
- [x] Alohida test bazasi: 2026-09-25 da mahalliy vaqtinchalik
      PostgreSQL klasteri (`initdb`, alohida port) va alohida Redis
      bilan ishladi, tunnel shart emas, testlar tez. Usul:
      `zakas042/README.md`, "Testlar"
- [ ] Buni skriptga aylantirish (`tools/test-local.sh`) — hozir qo'lda

### 1.4 Narx rejasini uzaytirish

**Holat (TODO.md bo'yicha, bazada tekshirilmagan):** narxlar
`2027-09-15` gacha bor. Undan keyingi sanaga qidiruv bo'sh javob
beradi va mehmonga sabab ko'rsatilmaydi. Oraliqning bir qismida
narx bo'lmasa, `averagePrice()` qolgan kunlarni o'rtacha narx
bilan to'ldirib yuboradi.

- [ ] Davriy vazifa narxni oldinga uzaytirsin, yoki admin panelda
      "narx tugayapti" ogohlantirishi chiqsin
- [ ] Oraliqda narxsiz kun bo'lsa sayt tushunarli xabar bersin

### 1.5 Production sozlamalari

- [ ] **[tashqi]** `/etc/systemd/system/hotel-backend.service` da
      `Environment=NODE_ENV=production` — shunda
      `assertProductionSafe()` ishga tushadi
- [ ] `docker-compose.yml` ni serverdagi haqiqiy sozlamaga
      moslashtirish (`hotel-*` nomlar, 3100/5433/6380 portlar)
      yoki eskirgan deb belgilash

### 1.6 Beds24 real hisobga ulash (FAZA 15)

**B-bo'limga ko'chirildi (2026-09-25).** Real API bilan solishtirish
va `statusMap.ts` tekshiruvi bajarildi (B1): Beds24 webhook'ni
imzolamaydi, `arrived`/`departed` subStatus yo'q, `black` — xona
yopilishi. Ulash: B5, egasining ruxsati bilan.

### 1.7 Yangi maydonlar

- [ ] **[qaror]** Qaytim (sdacha): mehmon 500 000 bersa 450 000
      yoziladi, 50 000 qo'lda qaytadi. Kerak bo'lsa `Payment` ga
      "berilgan summa" maydoni
- [ ] **[qaror]** Mehmon pasporti: `Guest` modelida pasport maydoni
      **yo'q** (TODO.md da "bor" deyilgan — noto'g'ri). Qonun talab
      qilsa migratsiya bilan qo'shiladi

---

## 2-bosqich. Xatolarni tuzatish

### 2.1 Bot ruxsati: begona odam Founder botini egallashi mumkin

**Qayerda:** [services/botAccess.ts:199](zakas042/backend/src/services/botAccess.ts#L199).

**Muammo:** username bo'yicha moslik topilsa, allaqachon bog'langan
`telegramId` ham qayta yoziladi. Egasi username'ni o'zgartirsa va
uni boshqa odam olsa, u moliya bo'limi bor botga kiradi, egasi
esa chiqib qoladi.

- [ ] Username orqali bog'lash faqat `telegramId` bo'sh bo'lganda
- [ ] Bog'langan yozuvda username faqat qo'shimcha ma'lumot bo'lsin
- [ ] Test

### 2.2 Founder hisobotida daromad kam chiqadi

**Qayerda:** [services/report.ts:196](zakas042/backend/src/services/report.ts#L196)
(`moneyReport`, `bookingReport`).

**Muammo:** hisobot faqat `narx × kecha + xizmatlar` ni sanaydi.
Nonushta (`mealPricePerPerson × kishi × kecha`) va bekor qilish
jarimasi (`cancellationFee`) kirmaydi. Saytdan kelgan bron har doim
nonushta bilan, shuning uchun daromad kam, qarz noto'g'ri ko'rinadi.
Shaxmatkadagi formula (`serializeReservation`) boshqacha — ikki joy
bir-biriga zid.

- [ ] Hisobot formulasini `serializeReservation()` bilan bitta
      manbaga keltirish (nonushta + jarima)
- [ ] `paid` uchun `else` zaxira yo'lini olib tashlash (davrda
      to'lov bo'lmasa boshqa manbadan sanaydi — mantiqsiz)
- [ ] **[qaror]** `PENDING_PAYMENT` bronlar daromadga kirsinmi

### 2.3 Beds24 webhook bron statusini orqaga qaytarishi

**Qayerda:** [services/webhookProcessor.ts:314](zakas042/backend/src/services/webhookProcessor.ts#L314).

**Muammo:** mavjud bron yangilanganda `ALLOWED_TRANSITIONS`
tekshirilmaydi. Check-in qilingan mehmon uchun Beds24 `new` yoki
noma'lum status yuborsa, bron `PENDING_PAYMENT`/`CONFIRMED` ga
qaytadi.

- [x] Beds24 "confirmed"/"new" xonadagi mehmonni (CHECKED_IN,
      CHECKED_OUT) orqaga qaytarmaydi; bekor qilish kelsa-yu mehmon
      xonada bo'lsa holat saqlanadi va `NEEDS_MANUAL_ACTION`
      (`mergeIncomingStatus`, B1)
- [x] Test (`queue.test.ts`, status mapping)

### 2.4 Erta check-out qolgan kunlarni bo'shatmaydi **[qaror]**

**Qayerda:** [services/reservations.ts:702](zakas042/backend/src/services/reservations.ts#L702),
[services/availability.ts:107](zakas042/backend/src/services/availability.ts#L107).

**Muammo:** izoh "qolgan kunlar bo'shaydi" deydi, lekin
`CHECKED_OUT` bron availability hisobida ham, DB constraint'da ham
band sanaladi. Mehmon 5 kecha o'rniga 2 kecha tursa, qolgan 3 kun
xona sotuvga chiqmaydi.

- [ ] Qaror: check-out sanasi bugunga qisqartirilsinmi? Summa
      haqiqiy kechalar bo'yicha qayta hisoblansinmi yoki to'liq
      summa qolsinmi?
- [ ] Tanlangan variantni amalga oshirish + Beds24'ga yuborish

### 2.5 Avtomatik bekor qilinganda jarima yozilishi **[qaror]**

**Qayerda:** [services/publicBooking.ts:724](zakas042/backend/src/services/publicBooking.ts#L724).

**Muammo:** muddati o'tgan to'lanmagan sayt broni
`cancelReservation()` orqali bekor qilinadi. Kirishga 24 soatdan
kam qolgan bo'lsa jarima yoziladi va Shaxmatkada qarz bo'lib
ko'rinadi — mehmon hech narsa to'lamagan.

- [ ] Avtomatik bekor qilishda jarima qo'llanmasin (tavsiya)

### 2.6 Bron amallaridagi validatsiya bo'shliqlari

**Qayerda:** `services/reservations.ts`, `routes/reservations.ts`.

- `changeRoom` / `changeDates` status va oraliq tekshiruvi →
  **S4 ga ko'chirildi**
- [ ] `PATCH /api/reservations/:id` narxni tarifdan pastga
      tushirganda `priceReason` so'ramaydi (`assertPriceOk`
      chaqirilmaydi) va sig'imni tekshirmaydi
- [ ] `POST /api/reservations`: `status` va `source` erkin matn —
      noto'g'ri qiymat 500 qaytaradi; xodim bronni darhol
      `CHECKED_OUT` holatida yarata oladi. Zod enum bilan cheklash
- [ ] `addPayment` tranzaksiyasiz: bir vaqtda kelgan ikki to'lov
      qarzdan oshib ketishi mumkin
- [ ] `GET /api/admin/sync-log?status=…`, `webhook-events?status=…`,
      `/rates?from=…` noto'g'ri qiymatda 500 qaytaradi — 400 bo'lsin

### 2.7 sync-log.html da XSS

**Qayerda:** `public/admin/sync-log.html`.

- [x] `errorMessage`, `externalId`, `eventType`, `action` ni
      `innerHTML` ga qo'yishdan oldin escape qilish. `mapping.html`
      (Beds24 xona nomlari) va `connection.html` da ham; inline
      `onclick` o'rniga `addEventListener` (2026-09-25)

### 2.8 Oshxona hisobi **[qaror]**

**Qayerda:** `services/kitchen.ts:95`.

**Holat:** hisobga `CHECKED_IN` + bugun keladigan `CONFIRMED`
**va `PENDING_PAYMENT`** kiradi (TODO.md faqat `CONFIRMED` deydi).
Saytdagi har bron nonushta bilan va to'lanmagan holatda yaratiladi,
shuning uchun kelmasligi mumkin bo'lgan mehmonga ham porsiya
sanaladi. Bugun kelib bugun ovqatlanmaydigan mehmon ham kiradi.

- [ ] Kim sanalishini aniqlash va shunga moslash

---

## 3-bosqich. Yaxshilash va tozalash

### Kod

- [ ] `routes/admin.ts:1616-1684` — `bot-access` route'lari ikki
      marta yozilgan, ikkinchisi hech qachon ishlamaydi. O'chirish
- [ ] `routes/admin.ts` — importlar fayl o'rtasida tarqalgan
      (50, 78-qatorlar), `parseOrThrow` va `parse` takrorlangan
- [ ] `reassignTask()` va `/cleaning/:id/reassign` — guruh
      mantiqiga mos emas. Kerakmi aniqlash: yo o'chirish, yo
      moslashtirish
- [ ] `Employee.telegramId`, `listCleaners()`, `CLEANER_POSITION` —
      TODO.md "ishlatilmaydi" deydi, lekin kod ularni eski zaxira yo'l
      sifatida ishlatadi (`cleaning-bot.ts:371`, `cleaning.ts:311`).
      Qoldirish yoki butunlay olib tashlashni hal qilish
- [ ] `isWorkingHours()`, `cleaningWorkStart/End` — hech qayerda
      chaqirilmaydi. O'chirish yoki "kelajak uchun" deb belgilash
- [ ] Shaxmatka JSX'ni brauzerda Babel bilan kompilyatsiya qiladi
      (2.9 MB). Production'da tezlikni o'lchash; sekin bo'lsa build
      vaqtida kompilyatsiya

### Repo

- [ ] `public/uploads/` git'da (2 ta tozalash rasmi) — o'chirish
      va `.gitignore` ga qo'shish
- [ ] `backend/.env.bak` — `.gitignore` ushlaydi, lekin diskdan
      o'chirish kerak (eski maxfiy qiymatlar)

### Testlar

1.3 bajarilgandan keyin.

- [ ] Hali sinalmagan 9 test faylini ishga tushirish va yiqilganlarini
      tuzatish: `availability`, `rates`, `realtime`, `queue`,
      `beds24`, `mapping`, `reconciliation`, `reservationSync`,
      `webhook`
- [ ] `AUTH_REQUIRED=true` bilan har rol uchun kirish chegaralari
      testi (FOUNDER / ADMIN / MANAGER / STAFF)
- [ ] 2-bosqichdagi har tuzatish uchun test

### Hujjatlar

- [ ] README.md: "Sinov rejimida, `AUTH_REQUIRED=false`" deydi,
      lekin auth yoqilgan — yangilash
- [ ] TODO.md: `Guest.passport` va `Employee.telegramId` haqidagi
      noto'g'ri da'volar; TODO.md ni shu faylga birlashtirish
- [x] PROJECT_LOGIC.md: "oltita shart" (oltinchisi qo'shildi) va
      "uch alohida bot" (2026-09-25)
- [ ] `TELEGRAM_CLEANING_GROUP_ID` formatini hujjatlashtirish
      (supergruh `-100…` bilan boshlanadi; tekshirish:
      `getChat?chat_id=<id>` → `ok: true`)

---

## Mijoz / egasi tasdiqlashi kerak

Kodda standart qiymat bilan ishlaydi. Noto'g'ri bo'lsa `Settings`
jadvalidan yoki admin paneldan o'zgartiriladi.

| Masala | Hozirgi qiymat |
|---|---|
| Tarif narxlari (9 ta) | so'm, admin qo'yadi; Beds24'ga kurs bilan $ da boradi (Q15) |
| Bekor qilish jarimasi | **Hal qilindi:** jarima yo'q (Q16, 2026-09-26) |
| OTA komissiyasi | 15% |
| Audit jurnali saqlash | 365 kun |
| Bolalar nonushtasi | kattalar bilan bir xil (narxni admin qo'yadi) |
| Xarajat turlari | 8 ta kategoriya — yetarlimi |
| Mehmon pasporti | maydon yo'q (1.7) |
| Erta check-out | 2.4 |
| Avto-bekor jarimasi | **Hal qilindi:** jarima yo'q (Q16) |
| To'lanmagan bron daromadmi | 2.2 |
| Oshxona kimni sanaydi | 2.8 |
| Qaytim hisobi | 1.7 |
| Mavjudlikdagi "ID" nimani bildiradi | S8. `Room.id` xona raqamining o'zi ("101"). Tavsiya: tarif ID + Beds24 ID + band katakda bron ID |
| OTA bronining sanasini PMS'da o'zgartirish | **Hal qilindi:** to'silgan (Q9 — Beds24 ustuvor) |
| Bron uzunligining yuqori chegarasi | S4 |
| Narx o'zgarishida tasdiqlash chegarasi (%) | S9 |
| Shaxmatkadagi Narxlar oynasi qolsinmi | S10 |
| Beds24 mulk valyutasi | **Hal qilindi:** USD (egasi tasdiqladi, 2026-09-25) |
| PMS valyutasi | **Hal qilindi:** so'm; Beds24 bronlari USD, tagida so'm (Q15, Q13 bekor) |
| B2 migratsiyasini jonli bazaga qo'llash | **Bajarildi** 2026-09-25 (egasi so'rovi bilan; SERVER.md) |
| Bazadagi eski bronlar | **Hal qilindi:** test ma'lumoti, tozalanadi (`npm run data:reset`) |
| Nonushta narxi | admin panel -> Oshxona (so'm, standart 25 000); o'zgarsa faol bronlarga qo'llash tanlovi |
| Beds24'ni real tizimga ulash vaqti | B5 — faqat egasining ruxsati bilan |
| Mehmonxona "bugun"i qaysi vaqt zonasida | S13 |

---

## Har bir ishdan keyin tekshirish

```bash
cd zakas042/backend
npx tsc --noEmit -p tsconfig.test.json   # xavfsiz, bazaga tegmaydi
```

Testlar faqat alohida test bazasida (1.3). Tunnel ochiq holda
`npm test` **ishga tushirilmaydi**.
