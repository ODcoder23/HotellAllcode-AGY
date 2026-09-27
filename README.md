# Imron Hotel PMS

Mehmonxona boshqaruv tizimi: sayt (mehmonlar broni), bandlik jadvali
(Shaxmatka), xodimlar paneli va Telegram botlar (egasi, tozalik, oshxona).

```
   Sayt (mehmon)      Qabulxona / egasi        Booking.com, Ostrovok
        |                    |                          |
        v                    v                          v
   PMS Backend  <->  PostgreSQL          <->   Beds24 (channel manager)
        |  WebSocket          \             webhook + polling / bron, narx, yopish
   Shaxmatka / Admin panel     Telegram botlar
```

**Beds24 — ikki tomonlama integratsiya** (2026-09-27, egasi qarori Q19,
avvalgidek qaytdi): OTA bronlari Beds24 orqali PMS'ga o'zi tushadi; PMS
bronlari, narxlari va yopiq kunlari Beds24'ga yuboriladi. **Beds24
ustuvor** — OTA bronining sanasi, narxi va bekor qilinishi OTA'da.
Beds24 bronlari dollarda, Shaxmatkada hamma xodimga `$` va so'mda (bron
kelgan kun kursi), to'lov so'mda — [BEDS24.md](BEDS24.md).

---

## Qayerdan boshlash

| Hujjat | Nima uchun |
|---|---|
| **[PROJECT_LOGIC.md](PROJECT_LOGIC.md)** | Loyiha qanday ishlaydi — qoidalar, modellar, oqimlar, ruxsatlar. **Avval shuni o'qing.** |
| **[ISH_REJASI.md](ISH_REJASI.md)** | Qolgan ishlar, qarorlar, tartib |
| [SERVER.md](SERVER.md) | Serverda ishlash, yangilash, zaxira |
| [zakas042/README.md](zakas042/README.md) | Kompyuterda ishga tushirish va testlar |
| [BEDS24.md](BEDS24.md) | Beds24 integratsiyasi: qoidalar, valyuta, ruxsatlar, ulash, real API faktlari |
| [zakas042/TZ-ASL.md](zakas042/TZ-ASL.md) | Mijozning asl topshirig'i va qarorlari |

---

## Tez boshlash

Butun infratuzilma **serverda** (Contabo VPS). Kompyuterda faqat kod.

```bash
bash tools/tunnel.sh        # tunnel ochish, terminal ochiq qoladi
```

Keyin brauzerda:

| Manzil | Nima |
|---|---|
| `http://localhost:3100` | Sayt (mehmonlar) |
| `http://localhost:3100/shaxmatka` | Bandlik jadvali |
| `http://localhost:3100/admin-panel` | Xodimlar paneli |

Kirish ma'lumotlari repoda saqlanmaydi (repo ochiq) — egasidan so'rang.
Parolni har foydalanuvchi o'zi o'zgartiradi: admin panel → yuqori
o'ngdagi avatar. Egasi "Foydalanuvchilar" bo'limidan boshqaning parolini
tiklaydi.

Kod o'zgartirgach:

```bash
bash tools/sync.sh restart  # serverga yuborish + build + qayta ishga tushirish
bash tools/status.sh        # holat
```

**Tunnel ochiq bo'lganda `npm test` ishga tushirmang** — lokal `.env`
tunnel orqali JONLI bazaga ulanadi. `vitest.setup.ts` nomida "test"
bo'lmagan bazada testni ishga tushirmaydi, lekin baribir faqat alohida
test bazasidan foydalaning: [zakas042/README.md](zakas042/README.md).

---

## Tuzilma

```
HotellAllcode/
├── PROJECT_LOGIC.md          loyiha logikasi — asosiy referens
├── ISH_REJASI.md             qolgan ishlar
├── SERVER.md                 server bilan ishlash
├── BEDS24.md                 Beds24 integratsiyasi
├── .github/workflows/ci.yml  testlar (har PR'da)
│
├── zakas042/                 asosiy loyiha
│   ├── backend/
│   │   ├── src/
│   │   │   ├── routes/       HTTP, validatsiya, auth
│   │   │   ├── services/     biznes mantiq (bron, narx, availability, Beds24 sinxron...)
│   │   │   ├── queues/       BullMQ: Beds24 navbatlari + davriy vazifalar (pms-maintenance)
│   │   │   ├── realtime/     WebSocket
│   │   │   ├── bot/          Telegram (3 bot)
│   │   │   └── lib/          config, pul formulasi, mehmonxona vaqti, auth
│   │   ├── prisma/           sxema, 25 migratsiya, seed
│   │   ├── scripts/          reset-test-data (test bronlarini tozalash)
│   │   ├── public/app/       frontend: sayt, Shaxmatka, admin panel
│   │   └── public/admin/     Channel manager alohida sahifalari (egasi, admin, menejer)
│   └── TZ-ASL.md             mijoz talabi (arxiv)
│
└── tools/                    tunnel, sync, status
```

---

## Asosiy raqamlar

| Narsa | Qiymat |
|---|---|
| Xona | 18 (3 qavat) |
| Tarif (xona turi) | 9 |
| Valyuta | So'm; Beds24 bronlari — USD (tagida so'm, bron kursi) |
| Vaqt | Mehmonxona kuni — Toshkent (UTC+5), `lib/hotelTime.ts` |
| Prisma | 24 model, 12 enum |
| Migratsiyalar | 25 |
| Testlar | 13 fayl, 263 test (ikkala AUTH_REQUIRED rejimida o'tadi, CI ham) |

---

## Hozirgi holat (2026-09-27)

**Ishlaydi:** sayt → bron → Shaxmatka zanjiri, overbooking himoyasi
(DB `EXCLUDE` constraint + tranzaksiya), tozalik boti (Telegram guruh),
oshxona hisobi, 4 rolli RBAC, parol o'zgartirish, mavjudlik jadvali,
moliya hisoboti, kunlik zaxira. STOP (sotuvni to'xtatish) 2026-09-27 da
olib tashlandi — sotuv Beds24 panelida yopiladi.
Autentifikatsiya, so'rov cheklovi va production rejimi yoqilgan.

**Beds24:** ikki tomonlama integratsiya kodda tayyor va testlangan (soxta
Beds24 bilan); serverga chiqarish va real hisobga ulash — egasi invite
code bergach ([BEDS24.md](BEDS24.md), 4-bo'lim; [SERVER.md](SERVER.md)).
