# 09 — Real-time Shaxmatka yangilanishi (WebSocket)

> **Manba:** `TZ-ASL.md` **15-band** (WebSocket, 6 ta event),
> **4-band** (*"Admin sahifani refresh qilmasdan ham yangi bronni
> ko'rishi uchun WebSocket/real-time update ishlatilsin"*).


**Bu fayl javob beradi:**

- Yangi bron Shaxmatkada qanday paydo bo'ladi?
- Qaysi event'lar yuboriladi?
- Ulanish uzilsa nima bo'ladi?
- Frontendga qancha o'zgartirish kerak?

---

## 1. Arxitektura

```
Backend voqeasi
(webhook qayta ishlandi / ichki amal bajarildi)
        ↓
   Database yangilandi          ← avval DB, keyin event
        ↓
   WebSocket server
        ↓
   Ulangan Admin/Shaxmatka klientlariga push
        ↓
   Frontend: mavjud reservations/rooms state'i yangilanadi
```

**Tartib muhim:** event faqat DB transaction muvaffaqiyatli
tugagandan **keyin** yuboriladi. Aks holda frontend DB'da yo'q
ma'lumotni ko'rsatib qo'yishi mumkin.

### Ko'p instansiya

Docker Compose bir nechta API konteyneri ko'targanda, klient A
1-konteynerga, klient B 2-konteynerga ulangan bo'lishi mumkin.
Redis pub/sub event'ni barcha instansiyalarga tarqatadi:

```
API-1 (event yaratdi) → Redis pub/sub → API-1, API-2, API-3
                                          ↓
                                   har biri o'z klientlariga
```

Redis allaqachon BullMQ uchun bor — qo'shimcha infratuzilma kerak emas.

---

## 2. Event turlari (TZ 15-band)

TZ aynan shu oltitasini talab qiladi:

```
reservation.created
reservation.updated
reservation.cancelled
room.status.changed
availability.changed
payment.updated
```

### Qo'shimcha event'lar

TZ'da sanalmagan, lekin boshqa bandlar talab qiladi:

| Event | Nima uchun | TZ bandi |
|---|---|---|
| `sync.failed` | Beds24'ga yuborilmagan bron haqida ogohlantirish | 11, 17 |
| `webhook.needs_attention` | Mapping yo'q / bo'sh xona yo'q | 5 |

Bular Shaxmatka uchun emas, **Admin panel ogohlantirishi** uchun.
Shaxmatka ularni e'tiborsiz qoldiradi.

---

## 3. Payload shakli

Payload Shaxmatkaning mavjud massiv elementlari bilan **aynan bir
xil** — shuning uchun frontendda oddiy "qo'sh yoki yangila" mantig'i
yetarli, yangi komponent kerak emas:

```jsonc
{
  "type": "reservation.created",
  "timestamp": "2026-09-12T10:30:00Z",
  "reservation": {
    "id": "clx...",
    "roomId": "102",
    "guestName": "Booking mehmoni",
    "phone": "+998 93 555 66 77",
    "checkIn": "2026-09-15",
    "checkOut": "2026-09-20",
    "adults": 2,
    "children": 0,
    "source": "booking_com",
    "pricePerNight": 38,
    "status": "confirmed",
    "notes": "",
    "withMeal": false,
    "charges": [],
    "payments": [{ "id": "...", "amount": 114, "method": "Onlayn",
                   "date": "2026-09-15", "note": "" }],
    "createdAt": 1789200000000
  },
  "room": { "id": "102", "status": "reserved" }
}
```

[02 §3](02-DATABASE-SXEMA.md) dagi moslik jadvali bu yerda ham amal qiladi:
`guestName`/`phone` flatten, `Decimal` → `number`, sana
`"YYYY-MM-DD"`, `source`/`status` kichik harfda.

### Frontenddagi mantiq (yagona qo'shimcha)

```js
useEffect(() => {
  const ws = connectWebSocket(token);

  ws.on("reservation.created", ({ reservation, room }) => {
    setReservations(rs =>
      rs.some(r => r.id === reservation.id) ? rs : [...rs, reservation]
    );
    if (room) setRooms(rs => rs.map(r => r.id === room.id ? {...r, ...room} : r));
  });

  ws.on("reservation.updated", ({ reservation }) => {
    setReservations(rs => rs.map(r => r.id === reservation.id ? reservation : r));
  });

  // ... qolgan event'lar
  return () => ws.close();
}, []);
```

**UI komponentlariga tegilmaydi** — faqat state yangilanadi, qolgani
React'ning o'zi qayta render qiladi.

---

## 4. Autentifikatsiya (TZ 18-band)

```
WebSocket ulanishi mavjud JWT tokeni bilan tasdiqlanadi
  → alohida login mexanizmi qo'shilmaydi
  → token yaroqsiz bo'lsa ulanish rad etiladi
  → token muddati tugasa ulanish uziladi, frontend qayta ulanadi
```

RBAC shu yerda ham amal qiladi: `STAFF` roli `sync.failed` kabi
texnik event'larni olmaydi ([10 §1](10-SECURITY-VA-SYNCLOG.md)).

---

## 5. Ulanish uzilishi

```
Ulanish uzildi
   ↓
Frontend exponential backoff bilan qayta ulanadi (1s, 2s, 4s... max 30s)
   ↓
Ulangach: REST orqali TO'LIQ holat qayta so'raladi
   GET /api/reservations?from=...&to=...
   GET /api/rooms
   ↓
State to'liq almashtiriladi
```

**Muhim printsip:** WebSocket — faqat "delta" yetkazish vositasi,
**haqiqat manbai emas**. Uzilish paytida o'tkazib yuborilgan
event'lar REST orqali qoplanadi. Bu ma'lumot yo'qolishining oldini
oladi va standart amaliyot.

---

## 6. TZ 4-band talabining bajarilishi

TZ: *"Shaxmatkada bron avtomatik paydo bo'ladi. Admin sahifani
refresh qilmasdan ham yangi bronni ko'rishi uchun WebSocket/real-time
update ishlatilsin."*

To'liq zanjir:

```
Booking.com'da mehmon bron qildi
   ↓  (Beds24 qabul qiladi)
Webhook → POST /api/webhooks/beds24        ([04](04-WEBHOOK-HANDLER.md))
   ↓
Queue → worker → xona avtomatik biriktiriladi   ([06 §5](06-XONA-MAPPING.md))
   ↓
Reservation DB'ga yozildi
   ↓
WebSocket: reservation.created
   ↓
Shaxmatkada bron PAYDO BO'LADI — refresh yo'q
```

Kechikish odatda **1–3 soniya** (Beds24 webhook tezligiga bog'liq).

**FAZA 8 tekshiruvi:** Shaxmatka ochiq turgan brauzerda, Beds24'da
test bron yaratiladi va sahifa yangilanmasdan bron paydo bo'lishi
ko'z bilan tasdiqlanadi.

---

## 7. Amalga oshirilgan holat (FAZA 8 — bajarildi)

Kod joylashuvi:

| Fayl | Vazifasi |
|------|----------|
| `backend/src/realtime/events.ts` | Event turlari, `RealtimeMessage` union |
| `backend/src/realtime/server.ts` | WebSocket server + Redis pub/sub |
| `backend/src/realtime/notify.ts` | Event yuborish yordamchilari |
| `backend/src/realtime.test.ts` | 16 test (FAZA 8 mezoni ichida) |
| `index (7).html` | `createRealtimeClient`, `handleRealtime` |

Aniqlashtirilgan tafsilotlar:

- **Yo'l:** `ws://<host>:3000/ws` — HTTP server ustiga o'rnatiladi,
  alohida port kerak emas. Nginx uchun bitta `location /ws` qoidasi.
- **Redis kanali:** `pms:realtime`. Redis bo'lmasa `broadcast()`
  lokal klientlarga tushadi — bitta instansiyada Redis shart emas
  (TZ 17-band).
- **`connected` xabari:** ulanishda server `serverStartedAt` yuboradi.
  Bu qiymat o'zgargan bo'lsa — server qayta ishga tushgan, ya'ni
  o'tkazib yuborilgan event'lar bor: frontend `reload()` chaqiradi
  (§5 printsipi).
- **Heartbeat:** server har 30 soniyada `ping` yuboradi va o'lik
  ulanishlarni ro'yxatdan chiqaradi.
- **Monitoring:** `GET /health` javobida
  `realtime: { clients, redisPubSub, serverStartedAt }`.
- **Event tartibi:** event faqat DB transaction muvaffaqiyatli
  tugagandan **keyin** yuboriladi. Event yuborilmasa asosiy amal
  baribir bajarilgan — `notify*` xatolari log'ga tushadi, so'rovni
  yiqitmaydi.

Shaxmatka tomonidagi xatti-harakat:

- Logo yonida ulanish indikatori: yashil = ulangan, sariq (pulsatsiya)
  = uzilgan, qayta ulanmoqda. Uzilganda ma'lumot eskirishi mumkin —
  foydalanuvchi buni ko'radi.
- `availability.changed` e'tiborsiz qoldiriladi: Shaxmatka bandlikni
  bronlardan o'zi hisoblaydi. Event Website/Admin uchun.
- Admin event'lari (`sync.failed`, `webhook.needs_attention`,
  `rate.sync.updated`) Shaxmatkada ko'rsatilmaydi.
- `reservation.cancelled` kelganda bron massivda **qoladi**, statusi
  `cancelled` bo'ladi (TZ 2-band: tarix saqlanadi). Grid bekor
  qilinganlarni ko'rsatmaydi — xona bo'shab ko'rinadi. "Bron holati"
  filtri `Bekor qilingan`ga qo'yilsa ular yana ko'rinadi.

---

## 8. Nima bu bosqichga kirmaydi

- **Push-notification** (mobil/brauzer bildirishnoma) — TZ'da yo'q
- **Customer Website uchun real-time** — TZ 15-bandi faqat
  Shaxmatka/Admin uchun talab qiladi; Website'da holat REST orqali
  ko'rsatiladi ([13 §9](13-WEBSITE-INTEGRATSIYA.md))
- **Offline rejim** — TZ'da yo'q
