# Ish rejasi

**Yangilandi:** 2026-09-28. Faqat **ochiq** ishlar. Har band kod bilan
tekshirilgan — bajarilganlar olib tashlandi (tarix: `git log`).
Beds24 integratsiyasi 2026-09-27 da qaytdi (Q19), STOP olib tashlandi.

Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md) · Server:
[SERVER.md](SERVER.md) · Beds24: [BEDS24.md](BEDS24.md) · Channel manager
TZ va ish tartibi: [CHANNEL_MANAGER_TZ.md](CHANNEL_MANAGER_TZ.md)

Belgilar: **[qaror]** — avval egasining qarori kerak. **[tashqi]** —
kod tashqarisida (server, Beds24 kabineti).

---

## 0. Server va xavfsizlik

Server **yo'q**: 2026-09-27 da egasining buyrug'i bilan butunlay
o'chirildi (baza ham, nusxasiz). Ishlab chiqarish yo'q — jonli
bazadagi eski ishlar (surilgan bronlarni topish va h.k.) endi
bajarib bo'lmaydi.

- [ ] **[qaror]** Qayta deploy qachon ([SERVER.md](SERVER.md)). Deploy
      bilan birga: 4 ta hisobga yangi parol (seed'dagi standart parol
      emas), yangi SSH parol, `.env` da `ENCRYPTION_KEY`,
      `WEBHOOK_URL_TOKEN`.
- [ ] **[qaror]** Eski `origin` repo (ODcoder23/imron-hotel-pms-full)
      **ochiq** — tarixida eski server IP, standart parol va 2 ta
      tozalash rasmi. Ish private `agy` repoda davom etadi. Ochiq repoga
      nima qilish (private / o'chirish) — egasi.
- [ ] **[tashqi]** Beds24'ni real hisobga ulash — deploy'dan keyin,
      [CHANNEL_MANAGER_TZ.md](CHANNEL_MANAGER_TZ.md) 9-bosqich.
      101-xonadagi qo'lda yopiq (30.09–03.10) endi yo'q — baza bilan
      birga o'chgan.
- [ ] **[tashqi]** Beds24 kabinetida eski API tokenni o'chirish.

## 1. Xatolar

Ochiq xato yo'q — 2026-09-28 da hammasi tuzatildi (`git log`).
Sayt bronlari bilan mehmonxonani band qilib qo'yish — 2-bo'limda,
chegara egasining qarori.

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
- [ ] **[qaror]** Sayt bronlari bilan mehmonxonani band qilib qo'yish.
      Hozir: bir IP'dan soatiga 5 ta bron, bir raqamga 24 soatda 3 ta
      to'lanmagan (raqamlar bo'yicha, 2026-09-28). Ko'p IP va ko'p raqam
      bilan butun mehmonxonani 24 soatga `PENDING_PAYMENT` qilib qo'yish
      mumkin. Variantlar: bir kechada to'lanmagan sayt bronlari uchun
      xonalar ulushi (masalan 50%), to'lov kutish muddatini qisqartirish
      (24 → 2–6 soat), oldindan to'lov.
- [ ] **[qaror]** Narx katta o'zgarganda (X% dan ko'p) tasdiqlash so'ralsinmi.
- [ ] **[qaror]** Qaytim (sdacha): `Payment` ga "berilgan summa" maydoni kerakmi.
- [ ] **[qaror]** Mehmon pasporti: `Guest` da maydon yo'q — qonun talab
      qilsa migratsiya bilan qo'shiladi.
- [ ] **[qaror]** Cheklovlar (`minStay`, `maxStay`, kirish/chiqish
      taqiqi) sayt/qabulxona bronida tekshirilmaydi — faqat Beds24 orqali
      OTA'larga ketadi; bolalar sig'imga kiradimi (PROJECT_LOGIC 17-bo'lim).
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
