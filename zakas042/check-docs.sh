#!/usr/bin/env bash
# ============================================================
#  check-docs.sh — hujjatlar va asosiy invariantlar tekshiruvi
#
#  Ishga tushirish:  bash zakas042/check-docs.sh
#  Chiqish kodi:     0 = toza, 1 = xato topildi
#
#  1. Hamma .md dagi nisbiy havolalar mavjud faylga ishora qiladimi
#  2. Overbooking himoyasi (reservation_no_overlap) migratsiyalarda bormi
#  3. Seed raqamlari (18 xona / 9 tarif)
#  4. Mijoz qarorlari TZ-ASL.md da
#  5. Repoda ortiqcha fayl yo'q: ro'yxatdan tashqari .md, *.bak, .env
#     nusxalari, AI/sessiya fayllari (CLAUDE.md, "Fayllar")
# ============================================================

cd "$(dirname "$0")/.." || exit 1
ERRORS=0

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

# --- 1. Havolalar ------------------------------------------
echo "[1/5] Markdown havolalar..."
TOTAL=0; BROKEN=0
while IFS= read -r md; do
  dir=$(dirname "$md")
  while IFS= read -r target; do
    target="${target%%#*}"
    [ -z "$target" ] && continue
    TOTAL=$((TOTAL+1))
    if [ ! -e "$dir/$target" ]; then
      red "  ✗ $md → $target (yo'q)"
      BROKEN=$((BROKEN+1))
    fi
  done < <(grep -oE '\]\([^)#:]+(#[^)]*)?\)' "$md" | sed -E 's/^\]\(//; s/\)$//')
done < <(git ls-files '*.md')
[ "$BROKEN" -eq 0 ] && green "  ✓ $TOTAL havola — hammasi joyida" || ERRORS=$((ERRORS+BROKEN))

# --- 2. Overbooking himoyasi -------------------------------
echo "[2/5] Overbooking constraint..."
if grep -qs 'reservation_no_overlap' zakas042/backend/prisma/migrations/*/migration.sql; then
  green "  ✓ reservation_no_overlap migratsiyalarda bor"
else
  red "  ✗ reservation_no_overlap yo'q — TZ 3-band (overbooking) buziladi"
  ERRORS=$((ERRORS+1))
fi

# --- 3. Seed raqamlari -------------------------------------
echo "[3/5] Seed raqamlari (18 xona / 9 tarif)..."
SEED="zakas042/backend/src/lib/hotelLayout.ts"
ROOMS=$(grep -oE '\["[0-9]+[A-Za-z]?", *"[a-z0-9]+", *[0-9]+\]' "$SEED" | wc -l | tr -d ' ')
TYPES=$(grep -cE '^\s*\{ id: "[a-z0-9]+",' "$SEED" | tr -d ' ')
if [ "$ROOMS" = "18" ] && [ "$TYPES" = "9" ]; then
  green "  ✓ 18 xona, 9 tarif"
else
  red "  ✗ hotelLayout.ts: $ROOMS xona, $TYPES tarif (18 / 9 kutilgan)"
  ERRORS=$((ERRORS+1))
fi

# --- 4. Mijoz qarorlari ------------------------------------
echo "[4/5] Mijoz qarorlari (TZ-ASL.md)..."
MISSING=""
for q in Q1 Q2 Q3 Q5 Q6 Q7 Q8 Q9 Q15 Q16 Q19 Q20; do
  grep -qs "| $q |" TZ-ASL.md || MISSING="$MISSING $q"
done
[ -z "$MISSING" ] && green "  ✓ TZ-ASL.md da qayd etilgan" || { red "  ✗ TZ-ASL.md da yo'q:$MISSING"; ERRORS=$((ERRORS+1)); }

# --- 5. Ortiqcha fayllar -----------------------------------
# Hujjatlar ro'yxati yopiq: yangi mavzu mavjud faylga yoziladi
echo "[5/5] Ortiqcha fayllar..."
ALLOWED_MD="README.md CLAUDE.md PROJECT_LOGIC.md BEDS24.md SERVER.md ISH_REJASI.md TZ-ASL.md"
EXTRA=0
while IFS= read -r f; do
  case " $ALLOWED_MD " in
    *" $f "*) ;;
    *) red "  ✗ ro'yxatda yo'q hujjat: $f (mavjud hujjatga yozing — CLAUDE.md)"; EXTRA=$((EXTRA+1)) ;;
  esac
done < <(git ls-files '*.md')
while IFS= read -r f; do
  red "  ✗ repoda bo'lmasligi kerak: $f"; EXTRA=$((EXTRA+1))
done < <(git ls-files | grep -E '(\.bak$|(^|/)\.env($|\.)|(^|/)\.gstack/|(^|/)\.claude/|\.log$)' | grep -v '\.env\.example$')
[ "$EXTRA" -eq 0 ] && green "  ✓ ortiqcha fayl yo'q" || ERRORS=$((ERRORS+EXTRA))

echo
if [ "$ERRORS" -eq 0 ]; then green "NATIJA: toza"; exit 0; fi
red "NATIJA: $ERRORS xato"; exit 1
