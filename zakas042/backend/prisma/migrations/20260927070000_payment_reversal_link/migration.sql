-- ============================================================
--  To'lov qaytarish bog'lanishi (2026-09-27)
--
--  Har qaytarish (manfiy to'lov) asl to'lovga bog'lanadi, UNIQUE:
--  bitta to'lov faqat bir marta qaytariladi. Ilgari ikki to'lovli
--  bronda birinchisini ikki marta qaytarish mumkin edi.
--
--  Faqat bo'sh ustun qo'shiladi — mavjud ma'lumot o'zgarmaydi. Eski
--  qaytarishlar bog'lanmaydi (qaysi to'lovniki ekani izohdan aniq
--  emas); ular uchun eski tekshiruv (qaytarish <= to'langan) qoladi.
-- ============================================================

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "reversedPaymentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reversedPaymentId_key" ON "Payment"("reversedPaymentId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reversedPaymentId_fkey" FOREIGN KEY ("reversedPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
