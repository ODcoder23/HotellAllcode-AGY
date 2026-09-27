# Beds24 — faqat egasi uchun KUZATUV

**Holat (2026-09-27).** PMS Beds24 bilan **integratsiya qilinmaydi**:
2026-09-26 da egasi qarori bilan olib tashlangan (avtomatik import, PMS →
Beds24 yozish, "Beds24 ustuvor" qoidasi, `CHANNEL_OWNED` qulfi, $ to'lov).
Booking.com va boshqa OTA bronlarini qabulxona qo'lda kiritadi.

2026-09-27 dan egasi (**FOUNDER**) uchun Channel manager **kuzatuv
rejimida** ishlaydi: PMS Beds24'dan faqat o'qiydi (`services/beds24/client.ts`
faqat `GET`) va o'zi bilan solishtiradi. PMS bronlari, narxlari va Beds24'ga
hech narsa yozilmaydi. Boshqa rollar bu bo'limni ko'rmaydi (403).

---

## 1. Nima ko'rsatiladi

| Qayerda | Nima |
|---|---|
| Channel manager → Ulangan kanallar | ulanish, kredit, mapping (tur/unit), "Ulanishni tekshirish" |
| Channel manager → Sinxronizatsiya | jurnal (`SyncLog`); "Hoziroq tekshirish" (bronlar), "Narx va bo'sh joyni o'qish", "Farqni tekshirish" |
| Channel manager → Bronlar jurnali | Beds24 bronlari PMS bilan: mos / farq / PMS'da yo'q / bog'lanmagan / bron emas; webhook hodisalari |
| Umumiy hisobot → Kanal (Beds24) | PMS'da yo'q bronlar, farqlar xulosasi |
| Xona turlari → Dollar kursi | Markaziy bank (har 3 soat) yoki qo'lda — faqat ko'rsatish |
| Narxlar | kurs, `$`, Beds24 narxi bilan holat nuqtasi, "Beds24: tur …" |
| Shaxmatka bron oynasi | `$` summa, OTA bron raqami (`externalReference`), Beds24'dagi mos bron |
| `/admin/connection.html`, `/admin/mapping.html`, `/admin/sync-log.html` | shu ma'lumot alohida sahifada |

**Solishtiruv qoidasi** (`services/channel/monitor.ts`): avval OTA raqami
(`apiReference` = PMS `externalReference`), keyin xona (unit bog'lanishi)
yoki tarif (tur bog'lanishi) + sanalar. Har ochilishda PMS'ning joriy
holatidan qayta hisoblanadi (Beds24'ga so'rovsiz). Farq tekshiruvi:
Beds24 `numAvail` > PMS bo'sh xonalar → "ikki marta sotish xavfi"; narx
`price1` × kurs PMS narxidan 2% dan ko'p farq qilsa → "narx farqi".
Beds24 javobidan yo'qolgan bron `deleted` bo'ladi (yolg'on "PMS'da yo'q"
signal bermaydi).

**Davriy:** `CHANNEL_MONITOR_MINUTES` (standart 60) — bronlar, kalendar,
farq. Refresh token'ni ham tirik tutadi (30 kun ishlatilmasa o'ladi).

## 2. Ulash

1. Beds24 → Settings → Marketplace → API → **invite code**. Faqat **read**
   ruxsatlari yetadi: bookings, inventory, properties.
2. Serverda `.env` da `ENCRYPTION_KEY` bo'lishi shart (token AES-256-GCM
   bilan shifrlanadi) — [SERVER.md](SERVER.md).
3. Admin panel → Channel manager → Ulash → invite code (obyekt ID
   ixtiyoriy; noto'g'ri ID rad etiladi).
4. "Unit'larni avtomatik bog'lash" (unit nomi = PMS xona raqami), qolganini
   qo'lda.
5. Webhook (ixtiyoriy): `.env` da `WEBHOOK_URL_TOKEN`, Beds24'da URL
   `https://<domen>/api/webhooks/beds24/<token>`, versiya
   `twoWithPersonalData`. Webhook faqat jurnalga yoziladi.

2026-09-26 dagi eski token bazadan o'chirilgan — yangi kod kerak.

## 3. Beds24 tomonida qolganlar — EGASI qiladi

1. **Booking.com hali Beds24'ga ulangan.** Beds24'ga kelgan bron PMS'ga
   tushmaydi. Ikki marta sotmaslik uchun Booking.com'ni Beds24'dan uzing
   (yoki extranet'da sotuvni yoping) va bronlarni PMS'ga qo'lda kiriting.
   Kuzatuv "PMS'da yo'q" bronlarni ko'rsatadi.
2. **Booking.com broni: 101, 30.09–03.10, 3 kishi, $225.** PMS'da 101 shu
   kechalar uchun yopib qo'yilgan — mehmonni bron qilib kiriting, keyin
   yopishni oching.
3. Beds24'dagi 3 ta "direct" sinov bronini (24–27.09) bekor qiling.
4. Eski API token'ni Beds24 kabinetida o'chiring.
5. Sayt sinov broni (102, 26–30.09) haqiqiy bo'lmasa bekor qiling.

## 4. Real API faktlari (kuzatuv kodi shunga tayanadi)

Real hisobda `GET` bilan yoki rasmiy spetsifikatsiyada
(`https://beds24.com/api/v2/apiV2.yaml`) tekshirilgan.

**Token**
- `GET /authentication/setup` (header `code`) — invite code → refresh token.
- `GET /authentication/token` (header `refreshToken`) → access token, 24 soat.
- **Refresh token almashadi:** javobda yangi `refreshToken` kelsa, eskisi
  o'sha zahoti o'ladi — yangisi darhol saqlanadi, parallel yangilashlar
  bittaga birlashtiriladi.
- Scope yetishmasa ham `401 Token not valid`. `GET /authentication/details`
  — token ruxsatlari.

**Kredit:** 5 daqiqada ~100. Har javobda `X-Five-Min-Limit-Remaining`,
`X-Five-Min-Limit-Resets-In`, `X-Request-Cost`. 429 — kredit tugagan.

**Obyekt:** `GET /properties` xona turlarini faqat `includeAllRooms=true`
bilan beradi. Valyuta obyekt darajasida (real hisob — USD). Xona turi =
`roomId`, jismoniy xona = `unit`; **unit id har turda 1 dan boshlanadi** —
faqat `roomId` bilan birga noyob.

**Bronlar** (`GET /bookings`)
- Status berilmasa bekor qilinganlar kelmaydi — hamma status aniq
  so'raladi (`confirmed, request, new, cancelled, black, inquiry`).
- Javob sahifalanadi (`pages.nextPageExists`, `page=N`).
- Manba: `apiSource` ("Booking.com"), `channel` ("booking", "direct"),
  `apiReference` — OTA bron raqami. Mamlakat `country2` da.
- `black` — xona yopilishi, `inquiry` — so'rov: bron emas.
- `subStatus` da `arrived`/`departed` yo'q.

**Kalendar** (`GET /inventory/rooms/calendar`): `includeNumAvail`,
`includePrices`, `includeMinStay` bayroqlarisiz **bo'sh** keladi; kunlar
oraliqqa siqilgan (`{from, to, numAvail, price1}`); `numAvail` — bronlardan
keyingi sof son; narxsiz kun — yopiq.

**Webhook:** payload `{timeStamp, booking, infoItems, invoiceItems, ...}`,
`event` maydoni yo'q. **Imzo yo'q** — himoya URL'dagi maxfiy token. Narx
o'zgarishi uchun webhook yo'q.

## 5. Tarix (qisqa)

- **2026-09-25/26:** real hisob tahlili — `SyncLog` 17 983 yozuv (asosan
  mapping yo'qligidan FAILED), Beds24'da 4 ta bron PMS'da yo'q edi.
- **2026-09-26:** integratsiya olib tashlandi: zaxira (`pg_dump`) → mashq
  bazasida sinov → purge → migratsiya `20260926200000_remove_beds24`.
  Zaxiralar serverda: `/opt/hotel-pms/backups/*remove-beds24-2026-09-26-2049*`.
- **2026-09-27:** kuzatuv rejimi (migratsiya `20260927050200_channel_monitor`,
  jadvallar eski shaklda). Eski jurnal kerak bo'lsa zaxiradan
  `pg_restore --data-only -t SyncLog -t Channel ...` bilan tiklanadi
  (avval zaxira, egasining roziligi bilan).

Eski integratsiyaning to'liq tavsifi git tarixida (`62c834d` gacha).
