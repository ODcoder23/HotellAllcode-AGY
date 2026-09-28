import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { formatKitchenReport } from "./bot/kitchen-bot.js";
import { kitchenReport, type KitchenReport } from "./services/kitchen.js";
import { prisma } from "./lib/prisma.js";
import { addDays, hotelToday } from "./lib/hotelTime.js";

describe("Kitchen Bot formatters", () => {
  it("formats empty kitchen report correctly", () => {
    const emptyReport: KitchenReport = {
      date: "2026-09-18",
      totalGuests: 0,
      totalAdults: 0,
      totalChildren: 0,
      staying: 0,
      departing: 0,
      arriving: 0,
      rooms: [],
    };

    const formatted = formatKitchenReport(emptyReport, false);
    expect(formatted).toContain("BUGUNGI OSHXONA HISOBOTI");
    expect(formatted).toContain("2026-09-18");
    expect(formatted).toContain("0 nafar");
    expect(formatted).toContain("Ovqat bilan bron qilingan xonalar mavjud emas");
  });

  it("formats populated kitchen report with room breakdown", () => {
    const mockReport: KitchenReport = {
      date: "2026-09-18",
      totalGuests: 5,
      totalAdults: 4,
      totalChildren: 1,
      staying: 1,
      departing: 1,
      arriving: 0,
      rooms: [
        {
          roomId: "101",
          roomLabel: "Komfort 3 kishilik",
          adults: 2,
          children: 1,
          guestName: "Alisher Navoiy",
          source: "Sayt",
          state: "staying",
          arriving: false,
        },
        {
          roomId: "204",
          roomLabel: "Premium 4 kishilik",
          adults: 2,
          children: 0,
          guestName: "Zahiriddin Bobur",
          source: "Booking.com",
          state: "departing",
          arriving: false,
        },
      ],
    };

    const formatted = formatKitchenReport(mockReport, false);
    expect(formatted).toContain("Jami mehmonlar: <b>5 nafar</b>");
    expect(formatted).toContain("Kattalar: <b>4</b>");
    expect(formatted).toContain("Bolalar: <b>1</b>");
    expect(formatted).toContain("Xona 101");
    expect(formatted).toContain("Alisher Navoiy");
    expect(formatted).toContain("Porsiya: <b>3 ta</b> (2 katta, 1 bola)");
    expect(formatted).toContain("Xona 204");
    expect(formatted).toContain("Zahiriddin Bobur");
    expect(formatted).toContain("Porsiya: <b>2 ta</b> (2 katta)");
    expect(formatted).toContain("Bugun ketadi");
  });

  it("ertangi hisobot: bugun keladigan mehmon ertaga nonushta qiladi", () => {
    const mockReport: KitchenReport = {
      date: "2026-09-19",
      totalGuests: 2,
      totalAdults: 2,
      totalChildren: 0,
      staying: 0,
      departing: 0,
      arriving: 1,
      rooms: [
        {
          roomId: "105",
          roomLabel: "Oilaviy yarim lyuks",
          adults: 2,
          children: 0,
          guestName: "Mirzo Ulug'bek",
          source: "Qabulxona",
          state: "arriving",
          arriving: true,
        },
      ],
    };

    const formatted = formatKitchenReport(mockReport, true);
    expect(formatted).toContain("ERTANGI OSHXONA HISOBOTI");
    expect(formatted).toContain("Bugun keladi");
    expect(formatted).toContain("Mirzo Ulug'bek");
  });
});

/**
 * Nonushta tunashdan keyingi ertalab (2026-09-28, egasi tasdiqladi):
 * kelgan kuni yo'q, ketadigan kuni bor. Bazada — alohida test bazasi
 * (vitest.setup.ts).
 */
describe("Nonushta kuni (services/kitchen.ts)", () => {
  const today = hotelToday();
  const d = (n: number) => addDays(today, n);
  const ids: string[] = [];
  let guestId = "";
  let roomIds: string[] = [];

  beforeAll(async () => {
    const rooms = await prisma.room.findMany({ where: { isActive: true }, orderBy: { id: "desc" }, take: 5 });
    roomIds = rooms.map((r) => r.id);
    await prisma.reservation.deleteMany({ where: { roomId: { in: roomIds } } });
    guestId = (await prisma.guest.create({ data: { fullName: "Oshxona Test", phone: "+998900000777" } })).id;

    const mk = async (roomId: string, checkIn: Date, checkOut: Date, status: string, withMeal = true, extra = {}) => {
      const r = await prisma.reservation.create({
        data: {
          roomId, guestId, checkIn, checkOut, adults: 2, children: 0,
          pricePerNight: 100_000, source: "DIRECT", withMeal,
          status: status as never, ...extra,
        },
      });
      ids.push(r.id);
    };

    await mk(roomIds[0], d(0), d(2), "CONFIRMED");                // bugun keladi
    await mk(roomIds[1], d(-1), d(1), "CHECKED_IN");              // xonada, ertaga ketadi
    await mk(roomIds[2], d(-2), d(0), "CHECKED_IN");              // bugun ketadi
    await mk(roomIds[3], d(-1), d(2), "CHECKED_IN", false);       // nonushtasiz
    // Muddatidan oldin ketgan: chiqish sanasi ertaga, lekin kecha chiqdi
    await mk(roomIds[4], d(-3), d(1), "CHECKED_OUT", true, { checkedOutAt: new Date(d(-1).getTime() + 8 * 3_600_000) });
  });

  afterAll(async () => {
    await prisma.reservation.deleteMany({ where: { id: { in: ids } } });
    await prisma.guest.delete({ where: { id: guestId } }).catch(() => {});
  });

  it("bugun: kechani o'tkazganlar — xonadagi va bugun ketadigan; bugun keladigan YO'Q", async () => {
    const r = await kitchenReport(0);
    const byRoom = new Map(r.rooms.map((x) => [x.roomId, x.state]));
    expect(byRoom.get(roomIds[0])).toBeUndefined();            // kelgan kuni nonushta yo'q
    expect(byRoom.get(roomIds[1])).toBe("staying");
    expect(byRoom.get(roomIds[2])).toBe("departing");          // ketadigan kuni bor
    expect(byRoom.get(roomIds[3])).toBeUndefined();            // withMeal = false
    expect(byRoom.get(roomIds[4])).toBeUndefined();            // kecha ketib bo'lgan
  });

  it("ertaga: bugun keladigan ham, ertaga ketadigan ham sanaladi", async () => {
    const r = await kitchenReport(1);
    const byRoom = new Map(r.rooms.map((x) => [x.roomId, x.state]));
    expect(byRoom.get(roomIds[0])).toBe("arriving");
    expect(byRoom.get(roomIds[1])).toBe("departing");
    expect(byRoom.get(roomIds[2])).toBeUndefined();            // bugun ketdi
    expect(r.departing).toBeGreaterThanOrEqual(1);
    expect(r.arriving).toBeGreaterThanOrEqual(1);
  });
});
