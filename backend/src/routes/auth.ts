/**
 * Autentifikatsiya endpoint'lari — TZ 18-band
 *
 * Manba: 10-SECURITY-VA-SYNCLOG.md §1 (3-talab), §3, §7
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, ValidationError } from "../lib/errors.js";
import { loginLimiter } from "../lib/rateLimit.js";
import {
  requireAuth,
  requirePermission,
  type AuthedRequest,
} from "../lib/authMiddleware.js";
import { login, createUser, PERMISSIONS, can, type Permission } from "../services/auth.js";
import { audit } from "../services/auditLog.js";

export const authRouter = Router();

// --- POST /api/auth/login -----------------------------------
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    // Shakl xatosi ham bir xil xabar beradi — qaysi maydon
    // noto'g'ri ekanini aytish hujumchiga yordam beradi
    res.status(401).json({ error: "Email yoki parol noto'g'ri", code: "INVALID_CREDENTIALS" });
    return;
  }

  const result = await login(parsed.data.email, parsed.data.password);

  if (!result.ok) {
    res.status(401).json({ error: result.error, code: "INVALID_CREDENTIALS" });
    return;
  }

  await audit({
    userId: result.user.id,
    action: "user.login",
    entityType: "User",
    entityId: result.user.id,
    ipAddress: req.ip,
  });

  // passwordHash javobda YO'Q (TZ 18-band 1-talab)
  res.json({ token: result.token, user: result.user });
}));

// --- GET /api/auth/me ---------------------------------------
authRouter.get("/me", requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Kirish talab qilinadi", code: "UNAUTHORIZED" });
    return;
  }

  // Rol o'zgargan bo'lishi mumkin — token'dagi emas, DB'dagi
  // qiymat ishonchli
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, fullName: true, role: true, isActive: true },
  });

  const role = user?.role ?? req.user.role;

  res.json({
    user: user ?? { id: req.user.id, email: req.user.email, role: req.user.role },
    // Frontend qaysi tugmalarni ko'rsatishni shu ro'yxatdan biladi
    permissions: Object.keys(PERMISSIONS).filter((p) => can(role, p as Permission)),
  });
}));

// --- POST /api/auth/users — foydalanuvchi yaratish ----------
const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Parol kamida 8 belgi"),
  fullName: z.string().min(1),
  role: z.enum(["ADMIN", "MANAGER", "STAFF"]),
});

authRouter.post(
  "/users",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
    }

    const exists = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase().trim() },
    });
    if (exists) throw new ValidationError("Bu email allaqachon ro'yxatdan o'tgan");

    const user = await createUser(parsed.data);

    await audit({
      userId: req.user?.id,
      action: "user.created",
      entityType: "User",
      entityId: user.id,
      after: { email: user.email, role: user.role },
      ipAddress: req.ip,
    });

    res.status(201).json(user);
  })
);

// --- GET /api/auth/users ------------------------------------
authRouter.get(
  "/users",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      // passwordHash tanlanmaydi (TZ 18-band)
      select: { id: true, email: true, fullName: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(users);
  })
);

// --- PATCH /api/auth/users/:id — rol o'zgartirish -----------
const roleSchema = z.object({
  role: z.enum(["ADMIN", "MANAGER", "STAFF"]).optional(),
  isActive: z.boolean().optional(),
});

authRouter.patch(
  "/users/:id",
  requireAuth,
  requirePermission("user.manage"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("role yoki isActive kerak");

    const id = String(req.params.id);
    const before = await prisma.user.findUnique({
      where: { id },
      select: { role: true, isActive: true },
    });
    if (!before) throw new ValidationError("Foydalanuvchi topilmadi");

    // O'zining ADMIN huquqini olib tashlash — oxirgi admin qolib
    // ketmasligi uchun tekshiramiz
    if (parsed.data.role && parsed.data.role !== "ADMIN" && before.role === "ADMIN") {
      const admins = await prisma.user.count({ where: { role: "ADMIN", isActive: true } });
      if (admins <= 1) {
        throw new ValidationError("Oxirgi ADMIN rolini o'zgartirib bo'lmaydi");
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: parsed.data,
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });

    await audit({
      userId: req.user?.id,
      action: "user.role_changed",
      entityType: "User",
      entityId: id,
      before,
      after: parsed.data,
      ipAddress: req.ip,
    });

    res.json(user);
  })
);
