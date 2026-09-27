# Ishga tushirish — to'liq tekshiruv, serverga joylash, Beds24

**Boshlandi:** 2026-09-28. Egasining topshirig'i: loyihani yakuniy
holatga keltirish, qaytadan to'liq tekshirish, serverga qayta joylash
(eski o'rnatish 2026-09-27 da butunlay o'chirilgan) va Beds24'ni ulash.

Belgilar: `[x]` bajarildi · `[ ]` qoldi · **[egasi]** — egasi qiladi.

Bog'liq: [SERVER.md](SERVER.md) · [BEDS24.md](BEDS24.md) ·
[CHANNEL_MANAGER_TZ.md](CHANNEL_MANAGER_TZ.md) · [ISH_REJASI.md](ISH_REJASI.md)

---

## A. Lokal tekshiruv

- [x] Tip tekshiruvi va build (`tsc`)
- [x] Testlar ikkala `AUTH_REQUIRED` rejimida — 13 fayl, 276 test
- [x] Migratsiyalar bo'sh bazada noldan (27 ta); sxema bilan farq yo'q
- [x] `check-docs.sh` (havolalar, overbooking constraint, seed)
- [x] `npm audit` — express/qs yangilandi; `prisma` ichidagi `deepmerge-ts`
      faqat prisma 8.1+ da tuzatilgan, tashqi kirishi yo'q ([SERVER.md](SERVER.md))
- [x] Docker: `.dockerignore` yo'q edi (sirlar image'ga kirardi) — qo'shildi;
      `prisma` CLI runtime'da yo'q edi (npx internetdan mos kelmaydigan
      versiyani olardi) — dependencies'ga o'tdi; Alpine uchun OpenSSL;
      `postinstall` sxemadan oldin ishlab yiqilardi — tartib tuzatildi
- [x] Brauzer: sayt bron oqimi (kod, nonushta, "bronimni tekshirish"),
      Shaxmatka, admin panelning 18 bo'limi, Channel manager — konsol xatosiz.
      Sayt xulosasiga nonushta qatori qo'shildi
- [x] Xavfsizlik: production sozlamalari majburiy, login cheklovi, webhook
      tokeni; nginx `/ws` log qilmaydi (JWT URL'da), HSTS

## B. Serverga tayyorlash

- [x] Production boshlang'ich skripti (`src/cli/bootstrap.ts`): 18 xona,
      9 tarif, qavatlar, bitta FOUNDER — namuna bron, soxta xodim va
      standart parol YO'Q; ro'yxat seed bilan umumiy (`lib/hotelLayout.ts`)
- [x] Docker: yuklangan fayllar (`public/uploads`) uchun volume va huquq
- [x] Server uchun compose: portlar faqat `127.0.0.1`, sirlar `.env` da
- [x] nginx: HTTPS, WebSocket (`/ws`), fayl hajmi (`deploy/nginx.conf`)
- [x] Kunlik zaxira (`deploy/backup.sh`, 30 kun) va deploy oldidan zaxira
- [x] [SERVER.md](SERVER.md) yangi tuzilmaga; `tools/deploy.sh`, `status.sh`, `tunnel.sh`

## C. Serverga joylash

- [x] Port — registrdan (9001), loyiha registrga yozildi; `/srv/projects/hotel`
- [x] Kod, `.env` (yangi `JWT_SECRET`, `ENCRYPTION_KEY`, `WEBHOOK_URL_TOKEN`,
      baza paroli — serverda yaratildi); 3 ta Telegram bot tiklandi
- [x] Build va ishga tushirish, 27 migratsiya; deploy oldidan zaxira ishlaydi
- [x] SSL sertifikat (Let's Encrypt), HTTP → HTTPS, HSTS
- [x] Boshlang'ich ma'lumot (18 xona, 9 tarif), FOUNDER paroli egasiga
- [x] Tekshiruv: `/health`, sayt, Shaxmatka, admin panel, WebSocket (wss),
      API va `/uploads` tokensiz 401, noto'g'ri webhook tokeni 404.
      Topilib tuzatildi: sidebar'da qattiq yozilgan "2 yangi"; deploy
      skriptida `docker compose exec` ssh stdin'ini yutardi; zaxira
      papkasi hammaga o'qiladigan edi

## D. Beds24

- [ ] **[egasi]** Beds24 → Settings → Marketplace → API → invite code
      (bookings: o'qish + yozish; inventory: o'qish + yozish;
      properties: o'qish)
- [ ] Ulash → obyekt → unit'larni bog'lash → import natijasi
      (Channel manager → Ulanish; invite code bir martalik)
- [ ] Beds24 panelida webhook URL — Ulanish sahifasida "Webhook URL"
      (faqat egasi va admin ko'radi)
- [ ] Narxlar: tur darajasida bog'langan tarif Beds24'dan tortiladi yoki
      admin Narxlar bo'limida kiritadi
- [ ] Jonli sinov: Beds24'dagi bron → PMS; PMS broni → Beds24; bekor qilish

## E. Keyin — egasi

- [ ] **[egasi]** Haqiqiy domen (hozir vaqtinchalik manzil)
- [x] Telegram botlari (egasi, tozalik, oshxona) — lokal `.env` dagi tokenlar
      bilan tiklandi. Lokal `npm run dev` shu `.env` bilan ishga tushirilmasin —
      bitta bot ikki joydan so'ralsa Telegram 409 beradi
- [ ] **[egasi]** Xodimlar, maoshlar, nonushta narxi, foydalanuvchilar
- [ ] **[egasi]** Qarorlar — [ISH_REJASI.md](ISH_REJASI.md) 2-bo'lim
