# Imron Hotel PMS — backend
#
# Manba: 01-ARXITEKTURA-VA-QOIDALAR.md §5, 11-BOSQICHLAR-ROADMAP.md FAZA 0
#
# IKKI BOSQICHLI QURILISH: build bosqichida devDependencies va
# TypeScript kerak, ishga tushirishda esa faqat kompilyatsiya
# natijasi. Natijada tasvir kichik bo'ladi va ishlab chiqarishda
# ortiqcha paketlar turmaydi (TZ 18-band: hujum yuzasini kamaytirish).

# ---------- 1. Build ----------
FROM node:22-alpine AS build

# Prisma engine Alpine'da OpenSSL'siz ishlamaydi (libssl topilmaydi)
RUN apk add --no-cache openssl

WORKDIR /app

# Avval faqat manifest va sxema — kod o'zgarganda npm ci qayta
# ishlamasligi uchun (Docker layer cache). Sxema npm ci dan OLDIN:
# `postinstall` Prisma client'ni yasaydi (TypeScript unga tayanadi),
# sxemasiz u yiqiladi.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---------- 2. Runtime ----------
FROM node:22-alpine AS runtime

RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production

# Faqat ishlab chiqarish paketlari. `prisma` CLI ham shu yerda
# (dependencies): konteyner ishga tushishda `prisma migrate deploy`
# qiladi. Ilgari u devDependencies'da edi va `npx` CLI'ni internetdan
# eng oxirgi (mos kelmaydigan) versiyada yuklab olardi.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public
COPY scripts ./scripts

# Tozalash rasmlari — serverda volume shu papkaga ulanadi. Egasi `node`:
# bot rasmni yoza olsin (volume birinchi marta shu huquq bilan yaratiladi)
RUN mkdir -p public/uploads/cleaning && chown -R node:node public/uploads

# Root emas — konteyner buzilsa ham zarar chegaralangan
USER node

EXPOSE 3000

# `dumb-init` yo'q: Node 22 o'zi SIGTERM ni to'g'ri qabul qiladi va
# server.ts da toza to'xtash yozilgan (queue, Prisma, WebSocket)
CMD ["node", "dist/server.js"]
