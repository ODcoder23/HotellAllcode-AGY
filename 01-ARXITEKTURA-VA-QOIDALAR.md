# 01 — Arxitektura va o'zgarmas qoidalar

> **Manba:** `TZ-ASL.md` — "ASOSIY ARXITEKTURA" bo'limi, **12-band**
> (channel abstraksiyasi), **19-band** (asosiy qoida), **7-band**
> (source-of-truth), **20-band** (bir xil inventory).


**Bu fayl javob beradi:**

- Qaysi qatlam nimaga javobgar?
- Beds24 o'chsa PMS ishlaydimi?
- Narx/availability uchun kim source-of-truth?
- Kelajakda boshqa kanal qanday qo'shiladi?

---

## 1. Umumiy sxema

TZ'dagi arxitektura chizmasining texnik yoyilmasi:

```
                    ┌─────────────┐
                    │ Booking.com │
                    │   Airbnb    │
                    │   Expedia   │
                    └──────┬──────┘
                           │ (Beds24 — sertifikatlangan channel manager)
                           ▼
                     ┌───────────┐
                     │  Beds24   │◄─── control panel (mapping shu yerda, qo'lda)
                     └─────┬─────┘
                   API v2  │  ▲  Webhook
                           ▼  │
                 ┌────────────────────┐
                 │   PMS Backend      │
                 │  (Node/Express)    │
                 │  ┌──────────────┐  │
                 │  │ Sync Queue   │  │  Redis + BullMQ
                 │  └──────┬───────┘  │
                 └─────────┼──────────┘
                           ▼
                   ┌───────────────┐
                   │  PostgreSQL   │  ← ichki yagona haqiqat manbai
                   └───────┬───────┘
                           │  WebSocket (real-time push)
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
        Shaxmatka    /admin/*        Admin Panel
        (mavjud ○)   (biz yozamiz)   Website
                                     (kodga kirish yo'q ✗)
```

`○` = mavjud, UI'si o'zgartirilmaydi; faqat backend API va WebSocket'ga
ulanadi.
`✗` = kodga kirish yo'q — ular uchun API va spec tayyor turadi, lekin
ulash ishi scope'dan tashqarida.

`/admin/*` — backend ichidagi kichik sahifalar (mapping, ulanish holati,
sync loglari). Mavjud Admin Panelga tegilmaydi; usiz mapping kiritib
bo'lmaydi ([06 §3](06-XONA-MAPPING.md)).

---

## 2. Qatlamlar va mas'uliyat chegarasi

| Qatlam | Mas'uliyati | Beds24'ga bog'liqmi? |
|---|---|---|
| PostgreSQL | Reservation/Room/Payment uchun ichki haqiqat | ❌ Yo'q |
| PMS Backend (API) | Biznes mantiq, validatsiya, WebSocket | ❌ Yo'q |
| Beds24 Integration Service | Faqat Beds24 bilan gaplashish | ✅ Ha |
| Sync Queue (BullMQ) | Tashqi chaqiruvlarni asinxron bajarish | Bilvosita |

### Oltin qoida (TZ 19-band)

> *"PMSning ichki ishlashi Beds24ga bog'lanib qolmasin.
> PMS + Database mustaqil ishlaydi."*

Amaliy ma'nosi: **Beds24 Integration Service butunlay o'chirilsa ham**,
PMS Backend + Database + Shaxmatka + Admin Panel + Website o'z ichki
bron/to'lov jarayonini to'liq davom ettira olishi kerak.

Buning texnik kafolati:

1. Hech qanday HTTP so'rov Beds24 javobini **kutmaydi** — barcha
   tashqi chaqiruvlar navbat orqali, fire-and-forget ([05 §4](05-SYNC-QUEUE-BULLMQ.md)).
2. Beds24 kodi alohida modulda (`services/beds24/*`), qolgan kod uni
   faqat interfeys orqali chaqiradi.
3. Overbooking himoyasi **PMS ichida**, DB constraint darajasida —
   Beds24'ga bog'liq emas ([07 §5](07-AVAILABILITY-VA-RATES-SYNC.md)).

**Tekshirish usuli (FAZA 14):** `.env` da Beds24 o'chiriladi, butun
PMS to'liq ishlashi tasdiqlanadi.

---

## 3. Source-of-truth konfiguratsiyasi (TZ 7-band)

TZ: *"Qaysi tizim source-of-truth ekani konfiguratsiyada aniq
belgilanadi."* Ya'ni kod ichida qattiq yozilmaydi:

```
SOURCE_OF_TRUTH_RATES        = "pms" | "beds24"
SOURCE_OF_TRUTH_AVAILABILITY = "pms"        ← deyarli har doim
```

Qiymatlar `Settings` jadvalida saqlanadi ([02](02-DATABASE-SXEMA.md)), o'zgarishi
`AuditLog` ga yoziladi.

**Availability uchun har doim `pms` tavsiya qilinadi.** Sabab: TZ
3-bandi overbooking'ni mutlaqo taqiqlaydi, va bu faqat PMS o'z
inventarini o'zi boshqarganda ishonchli bo'ladi. Mehmon Shaxmatkada
yoki Website'da xona band qilgan zahoti, boshqa hech kim (OTA ham)
o'sha xonani ko'rmasligi kerak — bu TZ 3 va 20-bandning talabi.

**Narx uchun** ikkala yo'nalish ham mumkin, lekin bir vaqtda faqat
bittasi g'olib — aks holda cheksiz halqa ([07 §7](07-AVAILABILITY-VA-RATES-SYNC.md)).

---

## 4. Kanal abstraksiyasi (TZ 12-band)

TZ: *"Arxitektura faqat Beds24 bilan cheklanmasin... Bronevik,
MyBooking kabi kanallarni qo'shish mumkin bo'ladigan qilib yozilsin."*

Hech qanday kod biznes-mantiq qatlamida "Beds24" nomini qattiq
yozmaydi:

```ts
interface ChannelAdapter {
  pullReservations(since: Date): Promise<ExternalReservation[]>;
  pushReservation(reservationId: string): Promise<SyncResult>;
  pushAvailability(roomTypeId: string, from: Date, to: Date): Promise<SyncResult>;
  pushRates(roomTypeId: string, from: Date, to: Date): Promise<SyncResult>;
  handleWebhook(payload: unknown): Promise<WebhookResult>;
  getRoomTypes(): Promise<ExternalRoomType[]>;
}
```

`Beds24Adapter` — birinchi implementatsiya. Kelajakdagi adapterlar
shu interfeysni bajaradi; sync queue, mapping va status-mapping
mantig'i **qayta yozilmaydi**.

**TZ 12-band cheklovi:** API mavjud bo'lmagan platforma uchun fake API,
scraping yoki browser automation **ishlatilmaydi**. Adapter yozish
uchun rasmiy API shart.

---

## 5. Texnologik stack

TZ 11-band Redis + BullMQ ni, 13-band PostgreSQL ni to'g'ridan-to'g'ri
talab qiladi. Qolganlari mavjud stackka mos tanlangan:

- Backend: TypeScript, Node.js, Express
- ORM: Prisma (+ raw SQL migratsiya — [02 §2](02-DATABASE-SXEMA.md))
- DB: PostgreSQL (`btree_gist` extension bilan)
- Queue: Redis + BullMQ *(TZ 11-band)*
- Real-time: WebSocket *(TZ 15-band)*
- Deploy: Docker Compose, Nginx, HTTPS *(TZ 18-band)*

---

## 6. Uch ma'lumot oqimi

TZ uchta yo'nalishni alohida talab qiladi:

```
① Beds24 → PMS          (TZ 1, 4-band)    → [04](04-WEBHOOK-HANDLER.md)
   OTA'dan bron keladi, Shaxmatkada avtomatik ko'rinadi

② PMS → Beds24          (TZ 2, 6, 7-band) → [12](12-PMS-DAN-BEDS24-GA-SYNC.md)
   Shaxmatkadagi 8 ta amal Beds24'ga yetkaziladi

③ Website → PMS → Beds24 (TZ 3-band)      → [13](13-WEBSITE-INTEGRATSIYA.md)
   Mijoz saytdan bron qiladi, zanjir oxirigacha boradi
```

Uchalasi ham bitta umumiy qoidaga bo'ysunadi: **DB avval, tashqi
tizim keyin.** Ichki yozuv muvaffaqiyatli bo'lsa — amal bajarilgan
hisoblanadi; Beds24 tomoni navbat orqali, keyinroq.

---

## 7. "Bir xil inventory" kafolati (TZ 20-band)

TZ yakuniy natija sifatida barcha tizimlar bir xil inventory asosida
ishlashini talab qiladi. Bu **to'rt mexanizm** bilan ta'minlanadi:

| Mexanizm | Nima qiladi | Hujjat |
|---|---|---|
| DB constraint | PMS ichida qoplanuvchi bron jismonan mumkin emas | `02` §2 |
| Availability sync | Har o'zgarish darhol Beds24'ga | `07` §3 |
| Webhook + polling | OTA o'zgarishi PMS'ga (real-time + 15 daq zaxira) | `04` |
| Drift reconciliation | Kuniga bir marta solishtirish va tuzatish | `07` §6 |

Oxirgisi TZ'da to'g'ridan-to'g'ri yozilmagan, lekin 20-bandning
amaliy kafolati — usiz vaqt o'tishi bilan sezilmas farqlar to'planadi.

---

## 8. Scope chegaralari

Qisqacha: UI qayta dizayni, OTA bilan to'g'ridan-to'g'ri integratsiya,
to'lov provayderi va mobil ilova — **kirmaydi**.

→ To'liq ro'yxat sabablari bilan: [00-INDEX](00-INDEX.md) oxirgi bo'lim
