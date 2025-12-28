import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createDbApi } from "./db.js";

const makeTempDbApi = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chowsr-db-"));
  const dbPath = path.join(dir, "test.db");
  const api = createDbApi({ dbPath });
  return {
    api,
    cleanup: () => {
      api.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

describe("db", () => {
  let cleanup = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("supports a filesystem db path", () => {
    const temp = makeTempDbApi();
    cleanup = temp.cleanup;
    const db = temp.api;

    const created = db.createGroup({
      id: "g1",
      code: "abcd12",
      name: "Lunch",
      locationType: "city",
      locationValue: "Seattle",
      radius: 5,
      deadline: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: "open",
    });

    expect(created.code).toBe("ABCD12");
    expect(db.getGroupByCode("abcd12")?.id).toBe("g1");
    expect(db.getGroupById("missing")).toBeNull();

    const decided = db.updateGroupDecision("g1", {
      status: "closed",
      decidedRestaurantId: "r",
      decidedAt: "now",
    });
    expect(decided.status).toBe("closed");
    expect(decided.decidedRestaurantId).toBe("r");

    db.markResultSent("g1", "sent");
    expect(db.getGroupById("g1")?.resultSentAt).toBe("sent");
  });

  it("supports an in-memory db path", () => {
    const db = createDbApi({ dbPath: ":memory:" });
    db.close();
  });

  it("supports env DB_PATH and cwd fallback when options are omitted", () => {
    const originalCwd = process.cwd();
    const originalDbPath = process.env.DB_PATH;

    try {
      process.env.DB_PATH = ":memory:";
      const db1 = createDbApi();
      db1.close();

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chowsr-cwd-"));
      process.chdir(dir);
      delete process.env.DB_PATH;
      const db2 = createDbApi();
      db2.close();
      process.chdir(originalCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      process.chdir(originalCwd);
      if (originalDbPath == null) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = originalDbPath;
      }
    }
  });

  it("manages invites, members, restaurants, and votes", () => {
    const temp = makeTempDbApi();
    cleanup = temp.cleanup;
    const db = temp.api;

    db.createGroup({
      id: "g1",
      code: "CODE12",
      name: "Group",
      locationType: "city",
      locationValue: "X",
      radius: 1,
      deadline: "deadline",
      createdAt: "created",
      status: "open",
    });

    expect(db.listInvites("g1")).toEqual([]);
    expect(db.findInvite("g1", "x@example.com", "email")).toBeNull();

    db.insertInvites("g1", [
      {
        id: "i1",
        type: "email",
        value: "X@example.com",
        normalized: "x@example.com",
        status: "pending",
        createdAt: "t",
      },
      {
        id: "i2",
        type: "phone",
        value: "555-111-2222",
        normalized: "5551112222",
        status: "pending",
        createdAt: "t",
      },
    ]);

    expect(db.listInvites("g1").map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(db.findInvite("g1", "x@example.com", "email")?.id).toBe("i1");

    db.updateInviteStatus("i1", "sent", "sentAt", undefined);
    expect(db.listInvites("g1").find((i) => i.id === "i1")?.status).toBe(
      "sent"
    );
    expect(db.listInvites("g1").find((i) => i.id === "i1")?.error).toBeNull();

    db.updateInviteStatus("i1", "failed", "sentAt2", "boom");
    expect(db.listInvites("g1").find((i) => i.id === "i1")?.error).toBe(
      "boom"
    );

    expect(db.deleteInvite("g1", "missing")).toBeNull();

    db.markInviteJoined("i1", "joinedAt");
    expect(db.listInvites("g1").find((i) => i.id === "i1")?.status).toBe(
      "joined"
    );
    expect(db.deleteInvite("g1", "i1")).toBeNull();

    const deleted = db.deleteInvite("g1", "i2");
    expect(deleted?.id).toBe("i2");
    expect(db.listInvites("g1").map((i) => i.id)).toEqual(["i1"]);

    const member = db.createMember({
      id: "m1",
      groupId: "g1",
      name: "Alice",
      type: "email",
      contact: "x@example.com",
      joinedAt: "t",
    });
    expect(member?.id).toBe("m1");
    expect(db.getMemberById("missing")).toBeNull();
    expect(db.listMembers("g1").map((m) => m.id)).toEqual(["m1"]);
    expect(db.countMembers("g1")).toBe(1);

    db.storeRestaurants("g1", [
      {
        id: "r1",
        name: "A",
        cuisine: "Restaurant",
        distanceMiles: 1,
        distance: "1.0 mi",
      },
      {
        id: "r2",
        name: "B",
        cuisine: "Restaurant",
        distanceMiles: 2,
        distance: "2.0 mi",
      },
    ]);

    const restaurants = db.listRestaurants("g1");
    expect(restaurants.map((r) => r.id)).toEqual(["g1:r1", "g1:r2"]);

    db.upsertVote({
      id: "v1",
      groupId: "g1",
      restaurantId: "g1:r1",
      memberId: "m1",
      decision: "yes",
      createdAt: "t",
    });

    db.upsertVote({
      id: "v2",
      groupId: "g1",
      restaurantId: "g1:r1",
      memberId: "m1",
      decision: "no",
      createdAt: "t2",
    });

    expect(db.getVoteSummary("g1")).toEqual({
      "g1:r1": { yes: 0, no: 1 },
    });

    db.deleteVote("g1", "g1:r1", "m1");
    expect(db.getVoteSummary("g1")).toEqual({});

    db.upsertVote({
      id: "v3",
      groupId: "g1",
      restaurantId: "g1:r2",
      memberId: "m1",
      decision: "yes",
      createdAt: "t",
    });

    db.storeRestaurants("g1", [
      {
        id: "r3",
        name: "C",
        cuisine: "Restaurant",
        distanceMiles: 3,
        distance: "3.0 mi",
      },
    ]);

    expect(db.getVoteSummary("g1")).toEqual({});
    expect(db.listRestaurants("g1").map((r) => r.id)).toEqual(["g1:r3"]);
  });
});
