# Ish rejasi

**Yangilandi:** 2026-09-27. Faqat **ochiq** ishlar. Har band kod bilan
tekshirilgan — bajarilganlar va Beds24 integratsiyasi bilan birga
yopilganlar olib tashlandi (tarix: `git log`).

Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md) · Server:
[SERVER.md](SERVER.md) · Beds24: [BEDS24.md](BEDS24.md)

Belgilar: **[qaror]** — avval egasining qarori kerak. **[tashqi]** —
kod tashqarisida (server, Beds24 kabineti).

---

## 0. Darhol — xavfsizlik va jonli tizim

- [ ] **[tashqi]** Serverdagi 4 ta hisob parolini almashtirish (founder,
      admin, manager, staff) — hozir `prisma/seed.ts` dagi standart parol.
- [ ] **[tashqi]** Server SSH parolini almashtirish.
- [ ] **[qaror]** Repo ochiq: private qilish yoki git tarixini tozalash.
      Tarixda server IP, standart parol va 2 ta tozalash rasmi qolgan
      (fayllar 2026-09-27 da repodan chiqarildi, tarixda bor).
- [ ] **[tashqi]** Beds24 tomonida ([BEDS24.md](BEDS24.md), 3-bo'lim):
      Booking.com hali Beds24'ga ulangan; Booking.com broni (101,
      30.09–03.10) PMS'ga kiritilishi; Beds24'dagi 3 ta sinov bronini
      bekor qilish; eski API tokenni o'chirish.
- [ ] **[tashqi]** Channel manager (kuzatuv) ishlashi uchun: serverda
      `.env` ga `ENCRYPTION_KEY`, ikki migratsiyani qo'llash, egasi yangi
      invite code bilan ulaydi ([SERVER.md](SERVER.md), 2026-09-27).
- [ ] **[tashqi]** Sichqoncha bilan surilib ketgan bronlarni topish:
      jonli bazadan (faqat o'qib) oxirgi haftalarda o'zgargan bronlarni
      qabulxona ro'yxati bilan solishtirish, xatolarini "Sanalarni
      o'zgartirish" bilan tuzatish.

## 1. Xatolar

- [ ] **Shaxmatka `no_show` bronni band deb hisoblaydi.** Backend uni
      bo'sh deb biladi (`isRoomFree`, availability) — shaxmatkadagi
      `isRoomAvailable` faqat `cancelled` ni chiqaradi. Natija:
      qabulxona bo'sh xonaga bron qila olmaydi.
- [ ] **Shaxmatka yopilgan kunlarni ko'rsatmaydi.** Ta'mir/STOP bilan
      yopilgan kunlar (`GET /api/rooms/blocks`) jadvalda yo'q — xodim
      yopiq kunga bron qilmoqchi bo'lib, backenddan rad oladi.
- [ ] **Sana/xona o'zgartirish audit jurnaliga yozilmaydi**
      (`change-room`, `change-dates`) — kim, qachon, eski/yangi qiymat.
      Sana o'zgarmagan bo'lsa ham amal bajariladi (xona uchun to'silgan).
- [ ] **Sayt API'si `withMeal` ni qabul qiladi, lekin e'tiborsiz
      qoldiradi** (sayt broni har doim nonushta bilan). Maydonni olib
      tashlash yoki hisobga olish.
- [ ] **`/uploads` (tozalash rasmlari) login'siz ochiq.** Tozalik boti
      rasmni egasini tekshirishdan OLDIN diskka yozadi — rad etilgan rasm
      diskda qoladi.
- [ ] **Sayt bronini bot bilan to'ldirish:** telefon bo'yicha cheklov
      raqam almashtirilsa ishlamaydi; bir necha IP'dan butun mehmonxonani
      24 soatga `PENDING_PAYMENT` bilan band qilib qo'yish mumkin.
- [ ] Sayt bronida kod (`IMR-…`) bron yaratilgandan keyin alohida
      yoziladi (tranzaksiyadan tashqari); `addCharge` da qulf va audit yo'q.
- [ ] Umumiy hisobot telefonda gorizontal suriladi ("Manba bo'yicha"
      jadvali `grid g2` ichida).

## 2. Egasining qarori kerak

- [ ] **[qaror]** Erta check-out: chiqish sanasi bugunga qisqartirilsinmi?
      Hozir `CHECKED_OUT` bron qolgan kunlarni ham band qilib turadi
      (availability va overbooking constraint uni sanaydi) — xona qayta
      sotilmaydi. Summa ham o'zgarmaydi.
- [ ] **[qaror]** To'lanmagan (`PENDING_PAYMENT`) bronlar hisobot
      daromadiga kirsinmi (hozir kiradi).
- [ ] **[qaror]** Oshxona kimni sanaydi: hozir `CHECKED_IN` + bugun
      keladigan `CONFIRMED` **va `PENDING_PAYMENT`** — to'lanmagan sayt
      bronlari ham porsiyaga kiradi.
- [ ] **[qaror]** Bron uzunligining yuqori chegarasi (kecha soni).
- [ ] **[qaror]** Narx katta o'zgarganda (X% dan ko'p) tasdiqlash so'ralsinmi.
- [ ] **[qaror]** Qaytim (sdacha): `Payment` ga "berilgan summa" maydoni kerakmi.
- [ ] **[qaror]** Mehmon pasporti: `Guest` da maydon yo'q — qonun talab
      qilsa migratsiya bilan qo'shiladi.
- [ ] **[qaror]** `minStay` sayt/qabulxona bronida tekshirilmaydi;
      bolalar sig'imga kiradimi (PROJECT_LOGIC 17-bo'lim).
- [ ] **[qaror]** Tasdiqlash kerak bo'lgan standart qiymatlar: OTA
      komissiyasi 15%, audit jurnali 365 kun, bolalar nonushtasi = kattalar
      narxi, 8 ta xarajat turi.

## 3. Yaxshilashlar

- [ ] **Narx rejasini uzaytirish:** narxlar seed'dan 365 kun oldinga;
      tugagan kunga sayt "xona yo'q" deydi. Davriy vazifa uzaytirsin yoki
      admin panelda "narx qaysi sanagacha" ogohlantirishi.
- [ ] **"Sanalarni o'zgartirish" oynasi** (Shaxmatka): eski va yangi
      sanalar yonma-yon, summa farqi, saqlashdan oldin tasdiqlash,
      `checked_in` da kirish sanasi o'chiq, bron ID ko'rinsin.
- [ ] **Narxlar sahifasi:** `rate.write` huquqi yo'q rol faqat ko'rsin
      (hozir tahrirlashga urinib 403 oladi); Shaxmatkadagi Narxlar oynasi
      qolsinmi — **[qaror]**.
- [ ] **Mavjudlik:** band katak bosilganda o'sha bron ochilsin; bron
      o'zgarganda jadval o'zi yangilansin (WebSocket).
- [ ] **Shaxmatka katak chiziqlari** (Excel uslubi): aniq chiziqlar,
      oy almashishida qalin chiziq, sichqoncha turgan qator/ustun rangi.
- [ ] **Shaxmatka JSX'ni brauzerda Babel bilan kompilyatsiya qiladi**
      (~3 MB) — ochilish sekin. Oldindan build qilish.
- [ ] Testlar: `toKey`/`fromKey` Toshkent vaqtida; `change-dates` har
      status uchun.
- [ ] `docker-compose.yml` ni serverdagi haqiqiy sozlamaga moslash
      (serverda backend systemd, Postgres/Redis docker'da).

---

## Har bir ishdan keyin

```bash
cd zakas042/backend
npx tsc --noEmit -p tsconfig.test.json   # bazaga tegmaydi
```

Testlar faqat alohida test bazasida ([zakas042/README.md](zakas042/README.md),
"Testlar"). Tunnel ochiq holda `npm test` **ishga tushirilmaydi**. CI
(`.github/workflows/ci.yml`) har PR'da ikkala `AUTH_REQUIRED` rejimida
tekshiradi.
