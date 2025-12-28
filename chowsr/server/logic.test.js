import { describe, expect, it, vi } from "vitest";
import {
  computeStatus,
  computeWinner,
  createRateLimiter,
  normalizeContact,
  summarizeVotes,
} from "./logic.js";

describe("logic", () => {
  it("normalizes contacts", () => {
    expect(normalizeContact("  ", "email")).toBe("");
    expect(normalizeContact(" Test@Example.COM ", "email")).toBe(
      "test@example.com"
    );
    expect(normalizeContact(" (555) 123-4567 ", "phone")).toBe("5551234567");
  });

  it("summarizes votes for all restaurants", () => {
    const restaurants = [{ id: "a" }, { id: "b" }];
    expect(summarizeVotes({ a: { yes: 2, no: 1 } }, restaurants)).toEqual({
      a: { yes: 2, no: 1 },
      b: { yes: 0, no: 0 },
    });
  });

  it("computes winner and handles ties", () => {
    const restaurants = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(computeWinner({}, restaurants)).toBeNull();

    const summary = {
      a: { yes: 1, no: 0 }, // score 1
      b: { yes: 2, no: 1 }, // score 1, yesCount 2 (wins tiebreak)
      c: { yes: 0, no: 0 },
    };
    expect(computeWinner(summary, restaurants)).toBe("b");
  });

  it("computes status across open/closed/consensus/deadline", () => {
    const now = 1_700_000_000_000;
    const nowMs = () => now;
    const restaurants = [{ id: "a" }, { id: "b" }];

    const baseGroup = {
      status: "open",
      deadline: new Date(now + 60_000).toISOString(),
      decidedRestaurantId: null,
    };

    const status1 = computeStatus({
      group: baseGroup,
      membersCount: 3,
      summary: { a: { yes: 1, no: 0 } },
      restaurants,
      nowMs,
    });
    expect(status1.threshold).toBe(2);
    expect(status1.deadlineReached).toBe(false);
    expect(status1.consensusRestaurantId).toBeNull();
    expect(status1.votingComplete).toBe(false);

    const status2 = computeStatus({
      group: baseGroup,
      membersCount: 3,
      summary: { a: { yes: 2, no: 0 } },
      restaurants,
      nowMs,
    });
    expect(status2.consensusRestaurantId).toBe("a");
    expect(status2.winnerRestaurantId).toBe("a");
    expect(status2.votingComplete).toBe(true);

    const status3 = computeStatus({
      group: {
        ...baseGroup,
        deadline: new Date(now - 60_000).toISOString(),
      },
      membersCount: 2,
      summary: { b: { yes: 1, no: 0 } },
      restaurants,
      nowMs,
    });
    expect(status3.deadlineReached).toBe(true);
    expect(status3.winnerRestaurantId).toBe("b");
    expect(status3.votingComplete).toBe(true);

    const status4 = computeStatus({
      group: { ...baseGroup, status: "closed", decidedRestaurantId: "b" },
      membersCount: 1,
      summary: {},
      restaurants,
      nowMs,
    });
    expect(status4.votingComplete).toBe(true);
    expect(status4.winnerRestaurantId).toBe("b");

    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    const status5 = computeStatus({
      group: baseGroup,
      membersCount: 1,
      summary: {},
      restaurants: [],
    });
    expect(status5.deadlineReached).toBe(false);
    spy.mockRestore();
  });

  it("rate limits by ip and window", () => {
    let now = 0;
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 2,
      nowMs: () => now,
    });

    const mk = () => {
      const req = { ip: "1.2.3.4" };
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.payload = payload;
          return this;
        },
      };
      let nextCalled = 0;
      const next = () => {
        nextCalled += 1;
      };
      return { req, res, next, get nextCalled() { return nextCalled; } };
    };

    const a = mk();
    limiter(a.req, a.res, a.next);
    limiter(a.req, a.res, a.next);
    expect(a.nextCalled).toBe(2);

    limiter(a.req, a.res, a.next);
    expect(a.res.statusCode).toBe(429);
    expect(a.res.payload).toEqual({
      error: "Too many requests. Please wait a moment and try again.",
    });

    now = 2000;
    const b = mk();
    limiter(b.req, b.res, b.next);
    expect(b.nextCalled).toBe(1);

    const c = mk();
    c.req.ip = "";
    limiter(c.req, c.res, c.next);
    expect(c.nextCalled).toBe(1);

    const spy = vi.spyOn(Date, "now").mockReturnValue(0);
    const limiter2 = createRateLimiter({ windowMs: 1000, max: 1 });
    const d = mk();
    limiter2(d.req, d.res, d.next);
    limiter2(d.req, d.res, d.next);
    expect(d.res.statusCode).toBe(429);
    spy.mockRestore();
  });
});
