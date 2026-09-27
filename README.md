# Imron Hotel PMS

Mehmonxona boshqaruv tizimi: sayt (mehmonlar broni), bandlik jadvali
(Shaxmatka), xodimlar paneli va Telegram botlar (egasi, tozalik, oshxona).

```
   Sayt (mehmon)      Qabulxona / egasi
        |                    |
        v                    v
   PMS Backend  <->  PostgreSQL (yagona haqiqat manbai)
        |  WebSocket          \
   Shaxmatka / Admin panel     Telegram botlar
```

Tashqi channel manager bilan integratsiya YO'Q: Beds24 2026-09-26 da
egasi qarori bilan olib tashlandi, Booking.com va boshqa OTA bronlarini
qabulxona qo'lda kiritadi (manba "Booking.com" va h.k., komissiya
avtomatik). 2026-09-27 dan **egasi (FOUNDER)** uchun Channel manager
**kuzatuv rejimida** qaytdi: PMS Beds24'dan faqat o'qiydi va o'zi bilan
solishtiradi, hech narsa yozmaydi — [BEDS24.md](BEDS24.md).

---

## Qayerdan boshlash

| Hujjat | Nima uchun |
|---|---|
| **[PROJECT_LOGIC.md](PROJECT_LOGIC.md)** | Loyiha qanday ishlaydi — qoidalar, modellar, oqimlar, ruxsatlar. **Avval shuni o'qing.** |
| **[ISH_REJASI.md](ISH_REJASI.md)** | Qolgan ishlar, qarorlar, tartib |
| [SERVER.md](SERVER.md) | Serverda ishlash, yangilash, zaxira |
| [zakas042/README.md](zakas042/README.md) | Kompyuterda ishga tushirish va testlar |
| [BEDS24.md](BEDS24.md) | Beds24 kuzatuvi (faqat egasi), ulash, egasining ishlari, real API faktlari |
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
├── BEDS24.md                 Beds24 kuzatuvi (faqat egasi)
├── .github/workflows/ci.yml  testlar (har PR'da)
│
├── zakas042/                 asosiy loyiha
│   ├── backend/
│   │   ├── src/
│   │   │   ├── routes/       HTTP, validatsiya, auth
│   │   │   ├── services/     biznes mantiq (bron, narx, availability, STOP...)
│   │   │   ├── queues/       BullMQ davriy vazifalar (pms-maintenance)
│   │   │   ├── realtime/     WebSocket
│   │   │   ├── bot/          Telegram (3 bot)
│   │   │   └── lib/          config, pul formulasi, mehmonxona vaqti, auth
│   │   ├── prisma/           sxema, 24 migratsiya, seed
│   │   ├── scripts/          reset-test-data (test bronlarini tozalash)
│   │   ├── public/app/       frontend: sayt, Shaxmatka, admin panel
│   │   └── public/admin/     Channel manager alohida sahifalari (faqat egasi)
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
| Valyuta | **Faqat so'm** |
| Vaqt | Mehmonxona kuni — Toshkent (UTC+5), `lib/hotelTime.ts` |
| Prisma | 25 model, 10 enum |
| Migratsiyalar | 24 |
| Testlar | 14 fayl, 253 test (ikkala AUTH_REQUIRED rejimida o'tadi, CI ham) |

---

## Hozirgi holat (2026-09-27)

**Ishlaydi:** sayt → bron → Shaxmatka zanjiri, overbooking himoyasi
(DB `EXCLUDE` constraint + tranzaksiya), tozalik boti (Telegram guruh),
oshxona hisobi, 4 rolli RBAC, parol o'zgartirish, STOP (sotuvni
to'xtatish), mavjudlik jadvali, moliya hisoboti, kunlik zaxira.
Autentifikatsiya, so'rov cheklovi va production rejimi yoqilgan.

**Beds24:** integratsiya yo'q; egasi uchun faqat kuzatuv (Channel
manager). Beds24 kabinetidagi hisob va Booking.com ulanishi Beds24
tomonida hali turibdi — egasi o'zi yopishi kerak ([BEDS24.md](BEDS24.md), 3-bo'lim).
