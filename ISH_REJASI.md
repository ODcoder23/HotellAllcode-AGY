# Ish rejasi — ochiq ishlar

**Yangilandi:** 2026-09-28. Faqat **ochiq** ishlar: bajarilgani o'chiriladi
(tarix — `git log`). Loyiha logikasi: [PROJECT_LOGIC.md](PROJECT_LOGIC.md) ·
Server: [SERVER.md](SERVER.md) · Beds24: [BEDS24.md](BEDS24.md)

Belgilar: **[egasi]** — egasi qiladi yoki qaror beradi. **[tashqi]** — kod
tashqarisida (server, Beds24 kabineti).

---

## 1. Ishga tushirish — server va Beds24

Server 2026-09-28 da bo'sh bazadan qayta o'rnatilgan (SERVER.md): 18 xona,
9 tarif, bitta egasi hisobi.

- [ ] Serverga oxirgi o'zgarishlarni joylash (`bash tools/deploy.sh`):
      bir xonaga parallel bronlarda deadlock tuzatishi (`4841e2b`) va
      2026-09-28 tozalashi (oshxona, sayt broni, admin paneldagi yangi
      bo'limlar). Serverdagi `.env` dagi `PENDING_PAYMENT_TIMEOUT_HOURS`
      endi o'qilmaydi — o'chirsa bo'ladi.
- [ ] **[egasi]** Beds24 → Settings → Marketplace → API → invite code
      (bookings: o'qish + yozish; inventory: o'qish + yozish; properties: o'qish).
- [ ] Ulash → obyekt → unit'larni bog'lash → import natijasi
      (Channel manager → Ulanish; invite code bir martalik).
- [ ] Beds24 panelida webhook URL — Ulanish sahifasidagi "Webhook URL".
- [ ] Narxlar: tur darajasida bog'langan tarif Beds24'dan tortiladi yoki
      admin Narxlar bo'limida kiritadi.
- [ ] Jonli sinov: Beds24'dagi bron → PMS; PMS broni → Beds24; bekor qilish.
- [ ] **[tashqi]** Beds24 kabinetida eski API tokenni o'chirish.
- [ ] Zaxiradan tiklashni vaqtinchalik bazada sinash (SERVER.md, "Tiklash").
- [ ] **[egasi]** Haqiqiy domen (hozir vaqtinchalik `hotel.<ip>.sslip.io`).
- [ ] **[egasi]** Xodimlar, maoshlar, nonushta narxi, foydalanuvchilar;
      admin panel → Sozlamalar'dagi standart qiymatlarni tasdiqlash
      (OTA komissiyasi 15%, audit 365 kun, tozalash me'yori 30 daqiqa...).
- [ ] **[egasi]** Saytdagi aloqa ma'lumotlari: telefon `+998 66 123 45 67`
      namunaga o'xshaydi; manzil ikki joyda ikki xil ("Registon ko'chasi
      bo'yida" va "Umar Hayyom ko'chasi, 32-uy"); "aeroportdan bepul
      transfer" va'dasi to'g'rimi.

## 2. Egasining qarori kerak

- [ ] Eski `origin` repo (ODcoder23/imron-hotel-pms-full) **ochiq** —
      tarixida eski server IP va standart parol. Ish private `agy` repoda.
      Ochiq repoga nima qilish (private / o'chirish).
- [ ] Erta check-out: chiqish sanasi bugunga qisqartirilsinmi? Hozir
      `CHECKED_OUT` bron qolgan kunlarni ham band qilib turadi — xona qayta
      sotilmaydi, summa ham o'zgarmaydi.
- [ ] To'lanmagan (`PENDING_PAYMENT`) bronlar hisobot daromadiga kirsinmi
      (hozir kiradi).
- [ ] Sayt bronlari bilan mehmonxonani band qilib qo'yish. Sayt mehmoni
      kelganda to'laydi (Q20), avtomatik bekor o'chiq. Himoya: bir IP'dan
      soatiga 5 ta bron, bir raqamga 3 ta faol to'lanmagan sayt broni. Ko'p
      raqam va IP bilan baribir band qilish mumkin. Variantlar: bir kechada
      to'lanmagan sayt bronlari uchun xonalar ulushi, avtobekorni yoqish
      (Sozlamalar), oldindan to'lov.
- [ ] Kelmagan mehmon: kirish kuni o'tgan, kirishi belgilanmagan sayt broni
      avtomatik "Kelmadi" bo'lsinmi (hozir qo'lda).
- [ ] Bron uzunligining yuqori chegarasi (kecha soni; hozir 365).
- [ ] Narx katta o'zgarganda (X% dan ko'p) tasdiqlash so'ralsinmi.
- [ ] Qaytim (sdacha): `Payment` ga "berilgan summa" maydoni kerakmi.
- [ ] Mehmon pasporti: `Guest` da maydon yo'q — qonun talab qilsa migratsiya.
- [ ] Cheklovlar (`minStay`, `maxStay`, kirish/chiqish taqiqi) sayt va
      qabulxona bronida tekshirilmaydi — faqat Beds24 orqali OTA'larga
      ketadi. Bolalar sig'imga kiradimi (PROJECT_LOGIC, 17-bo'lim).
- [ ] Closed/Open (STOP) qaytadimi yoki kun Beds24 panelida yopilaveradimi.
- [ ] Ikkinchi channel manager rejadami (Channel Manager TZ 13-band):
      bo'lsa, biznes kodidagi qattiq yozilgan `"beds24"` registry'ga
      o'tkaziladi (BEDS24.md, "TZ ↔ kod").

## 3. Yaxshilashlar

- [ ] **Narx rejasini uzaytirish:** narx qo'yilmagan kunga sayt "xona yo'q"
      deydi. Davriy vazifa uzaytirsin yoki admin panelda "narx qaysi
      sanagacha" ogohlantirishi.
- [ ] **Shaxmatka va admin panel har ochilishda BARCHA bronlarni yuklaydi**
      (`GET /api/reservations` sanasiz) — bronlar ko'paygan sari sekinlashadi.
      Sana oralig'i bilan yuklash (ko'rinayotgan oy ± zaxira).
- [ ] **Shaxmatka JSX'ni brauzerda Babel bilan kompilyatsiya qiladi** (3 MB) —
      oldindan build qilish. nginx'da JS/CSS uchun gzip yoqish.
- [ ] Sayt (`index.html`) ichida 400 KB rasm base64 bo'lib turibdi — alohida
      fayl (brauzer keshlaydi).
- [ ] Sayt xato xabarlari backenddan o'zbekcha keladi — boshqa tildagi mehmon
      o'zbekcha matn ko'radi (umumiy xatolar tarjima qilingan, qolgani yo'q).
- [ ] "Sanalarni o'zgartirish" oynasi (Shaxmatka): eski va yangi sanalar
      yonma-yon, summa farqi, saqlashdan oldin tasdiqlash.
- [ ] Narxlar sahifasi: `rate.write` huquqi yo'q rol faqat ko'rsin (hozir
      tahrirlashga urinib 403 oladi).
- [ ] Mavjudlik: band katak bosilganda o'sha bron ochilsin; bron o'zgarganda
      jadval o'zi yangilansin (WebSocket).
- [ ] Testlar: `toKey`/`fromKey` Toshkent vaqtida; `change-dates` har status
      uchun; Telegram botlar oqimi (hozir faqat oshxona formati testlangan).

---

## Har bir ishdan keyin

`npm run typecheck` va testlar ikkala `AUTH_REQUIRED` rejimida — alohida
test bazasida ([README.md](README.md), "Testlar"). CI ham shuni tekshiradi.
