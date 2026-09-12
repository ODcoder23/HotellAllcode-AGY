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

> ⚠️ Mavjud Admin Panelda hozir qanday rollar borligi FAZA 0 da
> tekshiriladi va shu ro'yxat unga moslanadi.

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

## 9. Xavfsizlik cheklisti (FAZA 12 mezoni)

```
☐ ENCRYPTION_KEY .env da, repoda yo'q
☐ .env .gitignore da
☐ Token'lar DB'da shifrlangan
☐ API javobida hech qanday token yo'q (grep bilan tekshirilgan)
☐ sanitizeForLog() barcha SyncLog/WebhookEvent yozuvlarida
☐ SyncLog'da "token" qidiruvi bo'sh natija beradi
☐ JWT barcha ichki endpoint'larda majburiy
☐ RBAC har endpoint'da tekshiriladi
☐ Webhook validatsiyasi ishlaydi
☐ Rate limiting sozlangan
☐ HTTPS + Let's Encrypt
☐ AuditLog muhim amallarga ulangan
```

Hammasi belgilanganda FAZA 12 tugagan hisoblanadi.
