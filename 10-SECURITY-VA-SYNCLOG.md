# 10 — Xavfsizlik va SyncLog

> **Manba:** `TZ-ASL.md` **18-band** (9 ta xavfsizlik talabi),
> **16-band** (SyncLog tarkibi), **13-band** (credentials frontendga
> chiqmasin).


**Bu fayl javob beradi:**

- Token'lar qanday himoyalanadi?
- Nima log qilinmaydi?
- Qaysi rollar bor va kim nima qila oladi?
- SyncLog'da nima saqlanadi?

---

## 1. TZ 18-band — to'qqiz talab

| № | TZ talabi | Amalga oshirish | Faza |
|---|---|---|---|
| 1 | API credentials faqat backendda | `ChannelConnection.refreshToken/accessToken` — AES-256 bilan shifrlangan; API javob DTO'sida bu maydonlar **umuman yo'q** | 4 |
| 2 | `.env` / secure storage | `.env` `.gitignore` da; production'da Docker secrets yoki server env | 0 |
| 3 | JWT authentication | Barcha `/api/*` (public'dan tashqari) JWT talab qiladi | 2A |
| 4 | RBAC | 3 rol: `ADMIN` / `MANAGER` / `STAFF` (§3) | 12 |
| 5 | Webhook validation | Signature yoki IP whitelist + URL token ([04 §9](04-WEBHOOK-HANDLER.md)) | 6 |
| 6 | Rate limiting | `express-rate-limit` — webhook va public API'da qat'iy | 6, 13 |
| 7 | HTTPS | Nginx + Let's Encrypt | 0 |
| 8 | Audit log | `AuditLog` jadvali — kim, qachon, nima qildi (§4) | 12 |
| 9 | Sensitive data log qilinmasin | Markaziy `sanitizeForLog()` (§2) | 12 |

---

## 2. Log qilinmaydigan ma'lumotlar (TZ 16, 18-band)

TZ: *"Secret/token/password log qilinmasin."*

Hech qachon, hech qanday log yoki `SyncLog.request/response` da
saqlanmaydi:

- `refreshToken`, `accessToken` — to'liq yoki qisman
- Mehmonning to'lov karta ma'lumotlari (Beds24 orqali kelsa)
- Parollar, parol hash'lari
- JWT token'lar
- Webhook secret / URL token

### Markaziy sanitizatsiya

```ts
// utils/sanitizeForLog.ts
const SENSITIVE_KEYS = [
  "token", "accessToken", "refreshToken", "authorization",
  "password", "passwordHash", "secret", "apiKey",
  "cardNumber", "cvv", "cvc", "cardHolder", "expiryDate",
  "creditCard", "iban",
];

export function sanitizeForLog(data: unknown, depth = 0): unknown {
  if (depth > 10) return "[MAX_DEPTH]";
  if (data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(v => sanitizeForLog(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const isSensitive = SENSITIVE_KEYS.some(k =>
      key.toLowerCase().includes(k.toLowerCase())
    );
    out[key] = isSensitive ? "[REDACTED]" : sanitizeForLog(value, depth + 1);
  }
  return out;
}
```

**Bitta funksiya, bitta joy.** Har controllerda alohida yozilmaydi.
Kalit qidiruvi `includes` bilan — `x-auth-token`, `user_password`
kabi variantlar ham tutiladi.

### FAZA 12 tekshiruvi

```bash
# Log chaqiruvlarida xom obyekt yuborilmayotganini tekshirish
grep -rn "console\.log\|logger\." src/ | grep -v sanitizeForLog

# SyncLog yozuvlarida token qoldiqlarini qidirish
psql -c "SELECT id FROM \"SyncLog\"
         WHERE request::text ILIKE '%token%'
            OR response::text ILIKE '%token%' LIMIT 5;"
```

Ikkinchi so'rov bo'sh natija qaytarishi kerak.

---

## 3. RBAC — uch rol

TZ 18-band "RBAC" ni talab qiladi, rollarni sanamaydi. Mehmonxona
ish jarayoniga mos uchta rol:

| Rol | Huquqlar |
|---|---|
| `ADMIN` | Hamma narsa: Beds24 ulanishi, mapping, `Settings`, source-of-truth, foydalanuvchilar |
| `MANAGER` | Bron (yaratish/o'zgartirish/bekor), narx, hisobotlar, SyncLog ko'rish. **Beds24 sozlamalariga kira olmaydi** |
| `STAFF` | Check-in/check-out, to'lov qabul qilish, xona holati. Narx va sozlamalarga tegmaydi |

```ts
const PERMISSIONS = {
  "channel.connect":   ["ADMIN"],
  "mapping.write":     ["ADMIN"],
  "settings.write":    ["ADMIN"],
  "user.manage":       ["ADMIN"],
  "reservation.write": ["ADMIN", "MANAGER"],
  "reservation.cancel":["ADMIN", "MANAGER"],
  "rate.write":        ["ADMIN", "MANAGER"],
  "synclog.read":      ["ADMIN", "MANAGER"],
  "checkin.write":     ["ADMIN", "MANAGER", "STAFF"],
  "payment.write":     ["ADMIN", "MANAGER", "STAFF"],
  "reservation.read":  ["ADMIN", "MANAGER", "STAFF"],
} as const;
```

> ⚠️ Mavjud Admin Panel kodiga kirish yo'q, shuning uchun undagi
> rollar bilan moslik tekshirilmaydi. Backend o'z RBAC tizimini
> yuritadi; keyinroq integratsiya kerak bo'lsa `UserRole` enum'i
> kengaytiriladi.

---

## 4. Audit log (TZ 18-band)

Har **muhim** amal `AuditLog` ga tushadi — kim, qachon, nima
o'zgartirdi:

```
mapping.created / mapping.updated / mapping.deleted
settings.changed          (ayniqsa source-of-truth almashtirilishi)
channel.connected / channel.disconnected
webhook.reprocessed       (qo'lda qayta ishlash)
reservation.cancelled     (kim bekor qildi)
reservation.no_show       (kim "kelmadi" deb belgiladi)
user.created / user.role_changed
```

```ts
await auditLog.record({
  userId: req.user.id,
  action: "settings.changed",
  entityType: "Settings",
  entityId: "SOURCE_OF_TRUTH_RATES",
  before: { value: "pms" },
  after:  { value: "beds24" },
  ipAddress: req.ip,
});
```

`before`/`after` ham `sanitizeForLog()` dan o'tadi.

**Farq:** `AuditLog` — **kim** qildi (odam harakati).
`SyncLog` — **nima** yuborildi (tizim harakati). Ikkalasi alohida.

---

## 5. SyncLog tuzilishi (TZ 16-band)

TZ aynan sakkiz maydonni talab qiladi — hammasi mavjud:

| TZ talabi | Maydon |
|---|---|
| channel | `channelId` |
| action | `action` |
| request | `request` (sanitized) |
| response | `response` (sanitized) |
| status | `status` |
| error | `errorMessage` |
| timestamp | `createdAt` |
| reservation ID | `reservationId` |

Qo'shimcha: `direction`, `attempt`, `durationMs`, `roomId` — debug
va tahlil uchun.

### Saqlash muddati

```
SUCCESS yozuvlari  → 30 kun, keyin o'chiriladi
FAILED yozuvlari   → 1 yil (tahlil va kelishmovchilik uchun)
AuditLog           → o'chirilmaydi
```

Tozalash — kunlik repeatable job. Sababi: `SyncLog` eng tez o'sadigan
jadval (har availability o'zgarishi yozuv yaratadi), cheksiz o'sishi
DB'ni sekinlashtiradi.

---

## 6. Credentials shifrlash

```ts
// utils/encryption.ts — AES-256-GCM
const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex"); // 32 bayt

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map(b => b.toString("base64")).join(":");
}
```

- `ENCRYPTION_KEY` — faqat `.env` da, repoga hech qachon kirmaydi
- Kalit yo'qolsa token'lar tiklanmaydi → invite code qayta olinadi
- Token'lar faqat `services/beds24/auth.ts` ichida deshifrlanadi,
  boshqa hech qayerda

### Frontendga hech qachon chiqmaydi (TZ 13-band)

```ts
// API javob DTO'si — token maydonlari UMUMAN yo'q
type ChannelConnectionDto = {
  id: string;
  channelCode: string;
  propertyId: string;
  isActive: boolean;
  isConnected: boolean;      // token yaroqlimi — faqat holat
  lastSyncAt: string | null;
};
```

Prisma `select` bilan token maydonlari **so'ralmaydi ham** — tasodifan
serializatsiya qilinishining oldi olinadi.

---

## 7. Rate limiting (TZ 18-band)

| Endpoint | Cheklov | Sabab |
|---|---|---|
| `POST /api/webhooks/beds24` | 100/daqiqa (IP) | tashqi hujumdan himoya |
| `POST /api/auth/login` | 5/daqiqa (IP) | brute-force |
| `GET /api/public/availability` | 30/daqiqa (IP) | scraping |
| `POST /api/public/reservations` | 5/soat (IP) | spam bron |
| Ichki API (JWT bilan) | 300/daqiqa | yumshoq |

Webhook cheklovi **bizning himoyamiz** — Beds24'ning bizga qo'ygan
cheklovi bilan aralashtirmaslik kerak (u [03 §3](03-BEDS24-API-INTEGRATSIYA.md) da).

---

## 8. Xato holatida xavfsizlik (TZ 17-band)

Beds24 ishlamay qolganda ham xavfsizlik talablari
**bo'shashtirilmaydi**:

- Token yangilash urinishlari ham exponential backoff'ga bo'ysunadi —
  har soniyada auth so'rovi yuborish taqiqlanadi
- Xato xabarlarida token yoki ichki tafsilot ko'rsatilmaydi;
  foydalanuvchi umumiy xabar ko'radi, batafsili `SyncLog` da
- Beds24 o'chirilgan bo'lsa ham JWT, RBAC, rate limiting to'liq
  ishlaydi

---

## 8.1. Amalga oshirilgan holat (FAZA 12 — bajarildi)

Kod joylashuvi:

| Fayl | Vazifasi |
|------|----------|
| `backend/src/services/auth.ts` | PERMISSIONS jadvali, JWT, bcrypt, login |
| `backend/src/lib/authMiddleware.ts` | requireAuth, requirePermission |
| `backend/src/services/auditLog.ts` | audit(), listAudit() |
| `backend/src/lib/rateLimit.ts` | besh xil cheklov (§7 jadvali) |
| `backend/src/routes/auth.ts` | login, me, users CRUD |
| `backend/src/security.test.ts` | 47 test — §9 cheklisti avtomatlashtirilgan |

**Ikki bayroq bilan boshqariladi** (`.env`):

- `AUTH_REQUIRED` — dev'da `false`, production'da **majburiy `true`**.
  Sabab: Shaxmatka hozircha login ekranisiz ishlaydi va FAZA 3 dan
  beri to'g'ridan-to'g'ri API'ga murojaat qiladi. Login ekrani
  qo'shilgach `true` qilinadi (FAZA 15 ro'yxatida).
- `RATE_LIMIT_DISABLED` — testlarda `true`. Testlar o'nlab so'rov
  yuboradi va cheklovga urilib qolishi mumkin; cheklovning o'zi
  alohida test bilan sinaladi.

`GET /health` ikkalasini ham ko'rsatadi (`security.auth`,
`security.rateLimit`) — topshirishda tekshirish shu yerdan.

**Rollarning haqiqiy xatti-harakati tekshirildi** (HTTP orqali,
`AUTH_REQUIRED=true` bilan):

| So'rov | Natija |
|---|---|
| Tokensiz `GET /api/rooms` | 401 UNAUTHORIZED |
| STAFF `GET /api/rooms` | 200 |
| STAFF `PUT /api/rate-plans` | 403 FORBIDDEN |
| MANAGER `PUT /api/rate-plans` | 200 |
| MANAGER `PUT /api/admin/settings` | 403 FORBIDDEN |
| Login 6-urinish (noto'g'ri parol) | 429 RATE_LIMITED |

**Testlar ikkala rejimda ham ishlaydi.** `vitest.setup.ts` global
`fetch` ni o'raydi: `AUTH_REQUIRED=true` bo'lsa PMS so'rovlariga
ADMIN token avtomatik qo'shiladi. Sabab: auth ilova darajasidagi
kesib o'tuvchi masala, uni 200+ test chaqiruviga qo'lda ulash
takrorlash bo'lardi va bittasi esdan chiqsa test sababsiz
yiqilardi. Auth mantig'ining o'zi `security.test.ts` da token
ataylab yubormasdan tekshiriladi.

**Seed uchala rolni yaratadi** (`admin@` / `manager@` / `staff@`,
parol `admin12345`) — RBAC testlari uchun va dasturchi har rolni
sinab ko'rishi uchun. Topshirishda birinchi qadam — parollarni
o'zgartirish.

**Audit ulangan amallar:** mapping yaratish/o'zgartirish/o'chirish,
source-of-truth almashtirilishi (before/after bilan), webhook qayta
ishlash, bron bekor qilish, no-show, narx o'zgartirish, foydalanuvchi
yaratish va rol o'zgarishi, login.

**Oxirgi ADMIN himoyasi:** yagona faol ADMIN rolini o'zgartirishga
urinish 400 beradi — aks holda tizimga hech kim kira olmay qolardi.

---

## 9. Xavfsizlik cheklisti (FAZA 12 mezoni)

```
☑ ENCRYPTION_KEY .env da, repoda yo'q          — test: "ENCRYPTION_KEY va JWT_SECRET"
☑ .env .gitignore da                           — test: ".env .gitignore da"
☑ Token'lar DB'da shifrlangan                  — test: "token'lar DB'da shifrlangan"
☑ API javobida hech qanday token yo'q           — test: "hech bir API javobida token qolmagan"
☑ sanitizeForLog() barcha yozuvlarda            — test: "sanitizeForLog token va parolni yashiradi"
☑ SyncLog'da "token" qidiruvi bo'sh             — test: "SyncLog'da 'token' qidiruvi"
☑ JWT barcha ichki endpoint'larda majburiy      — test: "tokensiz so'rov 401 beradi"
☑ RBAC har endpoint'da tekshiriladi             — test: "RBAC endpoint'larda" bloki
☑ Webhook validatsiyasi ishlaydi                — FAZA 6 testlari
☑ Rate limiting sozlangan                       — test: "login 5 urinishdan keyin 429"
☐ HTTPS + Let's Encrypt                         — SERVERDA sozlanadi (FAZA 15)
☑ AuditLog muhim amallarga ulangan              — test: "8. Audit log" bloki
```

O'n bir band avtomatik test bilan qoplangan — qo'lda tekshirish
o'rniga har yurishda qayta sinaladi.

HTTPS yagona qolgan band: u kodda emas, serverda sozlanadi
(Nginx + Let's Encrypt) va dasturchi topshirishda bajaradi
([11 FAZA 15](11-BOSQICHLAR-ROADMAP.md)).
