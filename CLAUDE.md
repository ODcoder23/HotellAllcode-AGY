# AI yordamchi uchun qoidalar

Bu jonli, real ishlatiladigan mehmonxona tizimi. Loyiha haqida: [README.md](README.md).

## Fayllar

- **Yangi `.md` fayl ochilmaydi.** Hujjatlar: README, PROJECT_LOGIC, BEDS24,
  SERVER, ISH_REJASI, TZ-ASL (va shu fayl). Yangi ma'lumot mavzusi tegishli
  faylga yoziladi; reja, tahlil va hisobot — chatda. `zakas042/check-docs.sh`
  ro'yxatdan tashqari `.md` ni CI'da yiqitadi.
- Repoga yozilmaydi: `*.bak`, `.env` nusxalari, sessiya jurnallari,
  AI skill/sozlama fayllari, vaqtinchalik skriptlar. Vaqtinchalik narsa —
  sessiya scratchpad papkasida, ish tugagach o'chiriladi.
- Ish tugagach ishga tushirilgan jarayonlar (test Postgres, Redis, server)
  to'xtatiladi.
- Bajarilgan ish ISH_REJASI.md dan o'chiriladi (tarix — `git log`), hujjat
  kodga zid bo'lib qolmasin: kod o'zgarsa tegishli hujjat shu commit'da
  yangilanadi.

## Xavfsizlik

- Testlar bazani tozalaydi — faqat alohida test bazasida (README, "Testlar").
  Serverda yoki server bazasida test/seed ishga tushirilmaydi.
- Lokal `.env` ga jonli Telegram tokenlari yozilmaydi (serverdagi botlar 409 bilan to'xtaydi).
- Server — jonli tizim: har qanday deploy yoki bazaga yozishdan oldin zaxira
  (SERVER.md) va egasining roziligi.
- Repoga server IP, parol, token, mehmon ma'lumoti, real bron raqami yozilmaydi.
  Ish `agy` (private) repoga push qilinadi; `origin` — ochiq, unga push yo'q.

## Tekshiruv

Har o'zgarishdan keyin: `npm run typecheck` va testlar ikkala
`AUTH_REQUIRED` rejimida (README, "Testlar"). Biznes qoidasi o'zgarsa —
avval egasining qarori, keyin TZ-ASL.md ga yangi Q-band.
