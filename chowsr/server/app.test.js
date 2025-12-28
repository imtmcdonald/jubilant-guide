import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createDbApi } from "./db.js";
import { createApp } from "./app.js";
import { createRateLimiter } from "./logic.js";

const makeIds = (...values) => {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (!next) throw new Error("out of ids");
    return next;
  };
};

const fixedNowMs = 1_700_000_000_000;
const nowMs = () => fixedNowMs;
const nowIso = () => new Date(fixedNowMs).toISOString();

const makeDb = () => createDbApi({ dbPath: ":memory:" });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api", () => {
  it("returns 404 for unknown groups", async () => {
    const db = makeDb();
    const fetchRestaurants = vi.fn();
    const sendInviteNotification = vi.fn();
    const sendResultNotification = vi.fn();

    const app = createApp({
      db,
      fetchRestaurants,
      sendInviteNotification,
      sendResultNotification,
      nowMs,
      nowIso,
      restaurantLimiter: createRateLimiter({ windowMs: 60_000, max: 1000, nowMs }),
    });

    const code = "NOPE";
    await request(app).get(`/api/groups/${code}`).expect(404);
    await request(app).get(`/api/groups/${code}/state`).expect(404);
    await request(app).post(`/api/groups/${code}/invites`).send({ invites: [] }).expect(404);
    await request(app).delete(`/api/groups/${code}/invites/i1`).expect(404);
    await request(app).post(`/api/groups/${code}/join`).send({}).expect(404);
    await request(app).get(`/api/groups/${code}/members`).expect(404);
    await request(app).get(`/api/groups/${code}/restaurants`).expect(404);
    await request(app).post(`/api/groups/${code}/restaurants`).expect(404);
    await request(app).post(`/api/groups/${code}/votes`).send({}).expect(404);
    await request(app).post(`/api/groups/${code}/close`).expect(404);

    expect(fetchRestaurants).not.toHaveBeenCalled();
    expect(sendInviteNotification).not.toHaveBeenCalled();
    expect(sendResultNotification).not.toHaveBeenCalled();
    db.close();
  });

  it("creates a group and loads group state", async () => {
    const db = makeDb();
    const app = createApp({
      db,
      createId: makeIds("g1"),
      createCode: () => "ABCD12",
      nowMs,
      nowIso,
    });

    await request(app).get("/api/health").expect(200);

    await request(app).post("/api/groups").send({}).expect(400);

    const created = await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: nowIso(),
      })
      .expect(200);

    expect(created.body.group).toMatchObject({
      id: "g1",
      code: "ABCD12",
      name: "Lunch",
      status: "open",
    });

    const group = await request(app).get("/api/groups/abcd12").expect(200);
    expect(group.body.group.code).toBe("ABCD12");

    const state = await request(app).get("/api/groups/ABCD12/state").expect(200);
    expect(state.body.invites).toEqual([]);
    expect(state.body.members).toEqual([]);
    expect(state.body.restaurants).toEqual([]);
    expect(state.body.summary).toEqual({});
    expect(state.body.status).toMatchObject({
      votingComplete: false,
    });

    const members = await request(app).get("/api/groups/ABCD12/members").expect(200);
    expect(members.body.members).toEqual([]);

    const restaurants = await request(app)
      .get("/api/groups/ABCD12/restaurants")
      .expect(200);
    expect(restaurants.body.restaurants).toEqual([]);
    db.close();
  });

  it("manages invites and joining", async () => {
    const db = makeDb();
    const createId = makeIds(
      "g1",
      "selfInvite",
      "m1",
      "i2",
      "i3",
      "i4",
      "i5",
      "m2",
      "m3"
    );

    const sendInviteNotification = vi.fn(async ({ to }) => {
      if (to === "skip@example.com") return { status: "skipped", reason: "x" };
      if (to === "boom@example.com") throw new Error("boom");
      if (to === "string@example.com") throw "boom";
      return undefined;
    });

    const app = createApp({
      db,
      createId,
      createCode: () => "ABCD12",
      sendInviteNotification,
      nowMs,
      nowIso,
    });

    await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: new Date(fixedNowMs + 60_000).toISOString(),
      })
      .expect(200);

    await request(app).post("/api/groups/ABCD12/invites").send({ invites: [] }).expect(400);
    await request(app).post("/api/groups/ABCD12/invites").send({}).expect(400);

    const hostJoin = await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Host", type: "email", contact: "HOST@EXAMPLE.COM" })
      .expect(200);
    expect(hostJoin.body.member.id).toBe("m1");
    expect(hostJoin.body.members).toHaveLength(1);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Host", type: "email", contact: "host@example.com" })
      .expect(403);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "", type: "email", contact: "" })
      .expect(400);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Other", type: "email", contact: "other@example.com" })
      .expect(403);

    await request(app)
      .post("/api/groups/ABCD12/invites")
      .send({
        invites: [
          { type: "email", value: "host@example.com" },
          { type: "email", value: " " },
          { type: "email" },
        ],
      })
      .expect(400);

    const invitesRes = await request(app)
      .post("/api/groups/ABCD12/invites")
      .send({
        invites: [
          { type: "email", value: "host@example.com" }, // duplicate
          { type: "email", value: "skip@example.com" }, // skipped
          { type: "email", value: "boom@example.com" }, // failed (Error)
          { type: "email", value: "string@example.com" }, // failed (non-Error)
          { type: "phone", value: "(555) 111-2222" }, // treated as sent (undefined result)
        ],
      })
      .expect(200);

    const invites = invitesRes.body.invites;
    expect(invites).toHaveLength(5);

    const hostInvite = invites.find((i) => i.normalized === "host@example.com");
    expect(hostInvite.status).toBe("joined");
    await request(app)
      .delete(`/api/groups/ABCD12/invites/${hostInvite.id}`)
      .expect(400);

    const phoneInvite = invites.find((i) => i.type === "phone");
    const deleted = await request(app)
      .delete(`/api/groups/ABCD12/invites/${invites.find((i) => i.value === "boom@example.com").id}`)
      .expect(200);
    expect(
      deleted.body.invites.find((i) => i.value === "boom@example.com")
    ).toBeUndefined();

    const join2 = await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Guest", type: "email", contact: "skip@example.com" })
      .expect(200);
    expect(join2.body.member.id).toBe("m2");

    const join3 = await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Phone", type: "phone", contact: "5551112222" })
      .expect(200);
    expect(join3.body.member.type).toBe("phone");

    expect(sendInviteNotification).toHaveBeenCalled();
    db.close();
  });

  it("handles restaurant lookup success, rate limits, and failures", async () => {
    const db = makeDb();
    const createId = makeIds("g1", "selfInvite", "m1");
    const fetchRestaurants = vi.fn(async () => [
      {
        id: "r1",
        name: "A",
        cuisine: "Thai",
        distanceMiles: 1,
        distance: "1.0 mi",
      },
    ]);

    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, nowMs });
    const app = createApp({
      db,
      createId,
      createCode: () => "ABCD12",
      fetchRestaurants,
      nowMs,
      nowIso,
    });

    await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: nowIso(),
      })
      .expect(200);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Host", type: "email", contact: "host@example.com" })
      .expect(200);

    const res = await request(app).post("/api/groups/ABCD12/restaurants").expect(200);
    expect(res.body.status).toBe("success");
    expect(res.body.restaurants[0].id).toBe("g1:r1");
    expect(res.body.summary).toEqual({ "g1:r1": { yes: 0, no: 0 } });

    const app2 = createApp({
      db,
      fetchRestaurants,
      nowMs,
      nowIso,
      restaurantLimiter: limiter,
    });

    await request(app2).post("/api/groups/ABCD12/restaurants").expect(200);
    await request(app2).post("/api/groups/ABCD12/restaurants").expect(429);

    const noResults = vi.fn(async () => {
      const err = new Error("none");
      err.name = "NoResults";
      throw err;
    });
    const app3 = createApp({
      db,
      fetchRestaurants: noResults,
      nowMs,
      nowIso,
    });
    const empty = await request(app3).post("/api/groups/ABCD12/restaurants").expect(200);
    expect(empty.body.status).toBe("empty");

    const app4 = createApp({
      db,
      fetchRestaurants: vi.fn(async () => {
        throw "bad";
      }),
      nowMs,
      nowIso,
    });
    await request(app4).post("/api/groups/ABCD12/restaurants").expect(502);

    const app5 = createApp({
      db,
      fetchRestaurants: vi.fn(async () => {
        throw new Error("upstream");
      }),
      nowMs,
      nowIso,
    });
    const err = await request(app5)
      .post("/api/groups/ABCD12/restaurants")
      .expect(502);
    expect(err.body.error).toBe("upstream");

    db.close();
  });

  it("times out restaurant lookup", async () => {
    const db = makeDb();
    const createId = makeIds("g1");
    const fetchRestaurants = vi.fn(
      async () => await new Promise(() => {})
    );

    const app = createApp({
      db,
      createId,
      createCode: () => "ABCD12",
      fetchRestaurants,
      nowMs,
      nowIso,
      restaurantTimeoutMs: 10,
    });

    await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: nowIso(),
      })
      .expect(200);

    await request(app).post("/api/groups/ABCD12/restaurants").expect(504);
    db.close();
  });

  it("records votes and closes on consensus", async () => {
    const db = makeDb();
    const createId = makeIds(
      "g1",
      "selfInvite",
      "m1",
      "i2",
      "i3",
      "m2",
      "m3",
      "v1",
      "v2",
      "v3",
      "v4"
    );

    const fetchRestaurants = vi.fn(async () => [
      { id: "r1", name: "A", cuisine: "Thai", distanceMiles: 1, distance: "1.0 mi" },
      { id: "r2", name: "B", cuisine: "Thai", distanceMiles: 2, distance: "2.0 mi" },
    ]);
    const sendResultNotification = vi.fn(async () => ({ status: "sent" }));

    const app = createApp({
      db,
      createId,
      createCode: () => "ABCD12",
      fetchRestaurants,
      sendResultNotification,
      nowMs,
      nowIso,
    });

    await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: new Date(fixedNowMs + 60_000).toISOString(),
      })
      .expect(200);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Host", type: "email", contact: "host@example.com" })
      .expect(200);

    await request(app)
      .post("/api/groups/ABCD12/invites")
      .send({
        invites: [
          { type: "email", value: "a@example.com" },
          { type: "email", value: "b@example.com" },
        ],
      })
      .expect(200);

    const j2 = await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "A", type: "email", contact: "a@example.com" })
      .expect(200);

    const j3 = await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "B", type: "email", contact: "b@example.com" })
      .expect(200);

    const m1 = "m1";
    const m2 = j2.body.member.id;
    const m3 = j3.body.member.id;

    const restaurantsRes = await request(app)
      .post("/api/groups/ABCD12/restaurants")
      .expect(200);
    const r1 = restaurantsRes.body.restaurants[0].id;
    const r2 = restaurantsRes.body.restaurants[1].id;

    await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ restaurantId: r1, decision: "yes" })
      .expect(400);

    await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: "missing", restaurantId: r1, decision: "yes" })
      .expect(400);

    await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: m1, restaurantId: "nope", decision: "yes" })
      .expect(400);

    await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: m1, restaurantId: r1, decision: "maybe" })
      .expect(400);

    const first = await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: m1, restaurantId: r1, decision: "yes" })
      .expect(200);
    expect(first.body.status.votingComplete).toBe(false);

    const removed = await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: m1, restaurantId: r1, decision: null })
      .expect(200);
    expect(removed.body.summary[r1]).toEqual({ yes: 0, no: 0 });

    await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: m1, restaurantId: r1, decision: "no" })
      .expect(200);

    await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: m1, restaurantId: r1, decision: "yes" })
      .expect(200);

    const closed = await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: m2, restaurantId: r1, decision: "yes" })
      .expect(200);
    expect(closed.body.group.status).toBe("closed");
    expect(closed.body.group.resultSentAt).toBeTruthy();

    const closedVote = await request(app)
      .post("/api/groups/ABCD12/votes")
      .send({ memberId: m3, restaurantId: r2, decision: "no" })
      .expect(200);
    expect(closedVote.body.status.votingComplete).toBe(true);

    await request(app).post("/api/groups/ABCD12/close").expect(200);
    await request(app).post("/api/groups/ABCD12/close").expect(200);

    expect(sendResultNotification).toHaveBeenCalledTimes(3);

    db.close();
  });

  it("does not close when voting is not complete", async () => {
    const db = makeDb();
    const app = createApp({
      db,
      createId: makeIds("g1", "selfInvite", "m1"),
      createCode: () => "ABCD12",
      nowMs,
      nowIso,
    });

    await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: new Date(fixedNowMs + 60_000).toISOString(),
      })
      .expect(200);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Host", type: "email", contact: "host@example.com" })
      .expect(200);

    const res = await request(app).post("/api/groups/ABCD12/close").expect(200);
    expect(res.body.group.status).toBe("open");
    expect(res.body.status.votingComplete).toBe(false);
    db.close();
  });

  it("closes after the deadline with no winner and no result notifications", async () => {
    const db = makeDb();
    const sendResultNotification = vi.fn(async () => ({ status: "sent" }));
    const app = createApp({
      db,
      createId: makeIds("g1", "selfInvite", "m1"),
      createCode: () => "ABCD12",
      sendResultNotification,
      nowMs,
      nowIso,
    });

    await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: new Date(fixedNowMs - 60_000).toISOString(),
      })
      .expect(200);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Host", type: "email", contact: "host@example.com" })
      .expect(200);

    db.storeRestaurants("g1", [
      { id: "r1", name: "A", cuisine: "Thai", distanceMiles: 1, distance: "1.0 mi" },
    ]);

    const res = await request(app).post("/api/groups/ABCD12/close").expect(200);
    expect(res.body.group.status).toBe("closed");
    expect(res.body.group.decidedRestaurantId).toBeNull();
    expect(res.body.group.resultSentAt).toBeNull();
    expect(sendResultNotification).not.toHaveBeenCalled();
    db.close();
  });

  it("sends a result for closed groups that lack resultSentAt", async () => {
    const db = makeDb();
    const sendResultNotification = vi.fn(async () => ({ status: "sent" }));
    const app = createApp({
      db,
      createId: makeIds("g1", "selfInvite", "m1"),
      createCode: () => "ABCD12",
      sendResultNotification,
      nowMs,
      nowIso,
    });

    await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: nowIso(),
      })
      .expect(200);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Host", type: "email", contact: "host@example.com" })
      .expect(200);

    db.storeRestaurants("g1", [
      { id: "r1", name: "A", cuisine: "Thai", distanceMiles: 1, distance: "1.0 mi" },
    ]);
    db.updateGroupDecision("g1", {
      status: "closed",
      decidedRestaurantId: "g1:r1",
      decidedAt: nowIso(),
    });

    const res = await request(app).post("/api/groups/ABCD12/close").expect(200);
    expect(res.body.group.resultSentAt).toBeTruthy();
    expect(sendResultNotification).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("marks result sent even if the decided restaurant is missing", async () => {
    const db = makeDb();
    const sendResultNotification = vi.fn(async () => ({ status: "sent" }));
    const app = createApp({
      db,
      createId: makeIds("g1", "selfInvite", "m1"),
      createCode: () => "ABCD12",
      sendResultNotification,
      nowMs,
      nowIso,
    });

    await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: nowIso(),
      })
      .expect(200);

    await request(app)
      .post("/api/groups/ABCD12/join")
      .send({ name: "Host", type: "email", contact: "host@example.com" })
      .expect(200);

    db.storeRestaurants("g1", [
      { id: "r1", name: "A", cuisine: "Thai", distanceMiles: 1, distance: "1.0 mi" },
    ]);
    db.updateGroupDecision("g1", {
      status: "closed",
      decidedRestaurantId: "missing",
      decidedAt: nowIso(),
    });

    const res = await request(app).post("/api/groups/ABCD12/close").expect(200);
    expect(res.body.group.resultSentAt).toBeTruthy();
    expect(sendResultNotification).not.toHaveBeenCalled();
    db.close();
  });

  it("serves the built client when dist exists", async () => {
    const db = makeDb();
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "chowsr-dist-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<html>ok</html>", "utf8");

    const app = createApp({
      db,
      clientDistPath: dist,
      clientDistExists: () => true,
      nowMs,
      nowIso,
    });

    const res = await request(app).get("/anything").expect(200);
    expect(res.text).toContain("ok");

    db.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("works with createApp defaults", async () => {
    const app = createApp();

    const created = await request(app)
      .post("/api/groups")
      .send({
        name: "Lunch",
        locationType: "city",
        locationValue: "Seattle",
        radius: 5,
        deadline: new Date(fixedNowMs + 60_000).toISOString(),
      })
      .expect(200);

    const code = created.body.group.code;
    await request(app)
      .post(`/api/groups/${code}/join`)
      .send({ name: "Host", type: "email", contact: "host@example.com" })
      .expect(200);

    const state = await request(app).get(`/api/groups/${code}/state`).expect(200);
    expect(state.body.group.code).toBe(code);
  });
});
