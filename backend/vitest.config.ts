import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Modul importlaridan OLDIN ishlaydi — config.ts env'ni topadi
    setupFiles: ["./vitest.setup.ts"],
    // Testlar bir xil DB va mock holatiga tegadi — ketma-ket
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
