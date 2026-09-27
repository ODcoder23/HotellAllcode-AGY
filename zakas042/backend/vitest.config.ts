import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Modul importlaridan OLDIN ishlaydi — config.ts env'ni topadi
    setupFiles: ["./vitest.setup.ts"],
    // Testlar bir xil DB holatiga tegadi — ketma-ket
    fileParallelism: false,
    testTimeout: 30_000,

    /**
     * Hook chegarasi 30 s (vitest standarti 10 s).
     *
     * NEGA: `beforeEach` da bir necha tozalash amali bor (bronlar,
     * kesh, yopiq kunlar). Sekin diskli mashinada 10 s dan oshishi
     * mumkin. Testlar FAQAT alohida test bazasida ishlaydi
     * (vitest.setup.ts nomini tekshiradi) — hech qachon tunnel
     * orqali serverdagi bazada emas.
     */
    hookTimeout: 30_000,
  },
});
