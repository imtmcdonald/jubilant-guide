import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import * as defaultDbApi from "./db.js";
import { fetchRestaurants as defaultFetchRestaurants } from "./osm.js";
import {
  sendInviteNotification as defaultSendInviteNotification,
  sendResultNotification as defaultSendResultNotification,
} from "./notifications.js";
import {
  computeStatus,
  createRateLimiter,
  normalizeContact,
  summarizeVotes,
} from "./logic.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultClientDist = path.join(__dirname, "..", "dist");

export const createApp = (options = {}) => {
  const db = options.db ?? defaultDbApi;
  const fetchRestaurants = options.fetchRestaurants ?? defaultFetchRestaurants;
  const sendInviteNotification =
    options.sendInviteNotification ?? defaultSendInviteNotification;
  const sendResultNotification =
    options.sendResultNotification ?? defaultSendResultNotification;

  const nowMs = options.nowMs ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date(nowMs()).toISOString());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const createCode =
    options.createCode ??
    (() => crypto.randomBytes(3).toString("hex").toUpperCase());

  const clientDist = options.clientDistPath ?? defaultClientDist;
  const clientDistExists = options.clientDistExists ?? fs.existsSync;

  const restaurantLimiter =
    options.restaurantLimiter ??
    createRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 30,
      nowMs,
    });
  const restaurantTimeoutMs = options.restaurantTimeoutMs ?? 15000;

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "200kb" }));

  const notifyMembers = async ({ group, members, restaurant }) => {
    if (!restaurant) return;
    const sends = members.map((member) =>
      sendResultNotification({ member, group, restaurant })
    );
    await Promise.allSettled(sends);
  };

  const finalizeGroupIfNeeded = async ({
    group,
    members,
    restaurants,
    summary,
    status,
  }) => {
    if (!status.votingComplete) return { group, status };

    let updatedGroup = group;
    if (group.status !== "closed") {
      updatedGroup = db.updateGroupDecision(group.id, {
        status: "closed",
        decidedRestaurantId: status.winnerRestaurantId,
        decidedAt: nowIso(),
      });
    }

    if (status.winnerRestaurantId && !updatedGroup.resultSentAt) {
      const restaurant = restaurants.find(
        (item) => item.id === status.winnerRestaurantId
      );
      await notifyMembers({ group: updatedGroup, members, restaurant });
      const sentAt = nowIso();
      db.markResultSent(updatedGroup.id, sentAt);
      updatedGroup = db.getGroupById(updatedGroup.id);
    }

    return {
      group: updatedGroup,
      status: computeStatus({
        group: updatedGroup,
        membersCount: members.length,
        summary,
        restaurants,
        nowMs,
      }),
    };
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/groups", (req, res) => {
    const { name, locationType, locationValue, radius, deadline } = req.body;
    if (!name || !locationType || !locationValue || !radius || !deadline) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const group = db.createGroup({
      id: createId(),
      code: createCode(),
      name: String(name).trim(),
      locationType: String(locationType).trim(),
      locationValue: String(locationValue).trim(),
      radius: Number(radius),
      deadline: String(deadline),
      createdAt: nowIso(),
      status: "open",
    });

    return res.json({ group });
  });

  app.get("/api/groups/:code", (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }
    return res.json({ group });
  });

  app.get("/api/groups/:code/state", (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

    const invites = db.listInvites(group.id);
    const members = db.listMembers(group.id);
    const restaurants = db.listRestaurants(group.id);
    const rawSummary = db.getVoteSummary(group.id);
    const summary = summarizeVotes(rawSummary, restaurants);
    const status = computeStatus({
      group,
      membersCount: members.length,
      summary,
      restaurants,
      nowMs,
    });

    return res.json({ group, invites, members, restaurants, summary, status });
  });

  app.post("/api/groups/:code/invites", async (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

    const invites = Array.isArray(req.body.invites) ? req.body.invites : [];
    if (!invites.length) {
      return res.status(400).json({ error: "No invites provided." });
    }

    const existing = db.listInvites(group.id);
    const existingSet = new Set(
      existing.map((invite) => `${invite.type}:${invite.normalized}`)
    );
    const createdAt = nowIso();
    const newInvites = invites
      .map((invite) => {
        const type = invite.type === "phone" ? "phone" : "email";
        const value = String(invite.value || "").trim();
        const normalized = normalizeContact(value, type);
        if (!value || !normalized) return null;
        if (existingSet.has(`${type}:${normalized}`)) return null;
        return {
          id: createId(),
          type,
          value,
          normalized,
          status: "pending",
          createdAt,
        };
      })
      .filter(Boolean);

    if (!newInvites.length) {
      return res.status(400).json({ error: "No valid invites." });
    }

    db.insertInvites(group.id, newInvites);

    await Promise.allSettled(
      newInvites.map(async (invite) => {
        try {
          const result = await sendInviteNotification({
            type: invite.type,
            to: invite.value,
            groupName: group.name,
            groupCode: group.code,
          });
          if (result?.status === "skipped") {
            db.updateInviteStatus(
              invite.id,
              "skipped",
              nowIso(),
              result.reason
            );
          } else {
            db.updateInviteStatus(invite.id, "sent", nowIso(), null);
          }
        } catch (error) {
          db.updateInviteStatus(
            invite.id,
            "failed",
            nowIso(),
            error instanceof Error ? error.message : "Invite failed."
          );
        }
      })
    );

    return res.json({ invites: db.listInvites(group.id) });
  });

  app.delete("/api/groups/:code/invites/:inviteId", (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }
    const deleted = db.deleteInvite(group.id, req.params.inviteId);
    if (!deleted) {
      return res.status(400).json({ error: "Invite cannot be removed." });
    }
    return res.json({ invites: db.listInvites(group.id) });
  });

  app.post("/api/groups/:code/join", (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

    const { name, type, contact } = req.body;
    const contactType = type === "phone" ? "phone" : "email";
    const trimmedContact = String(contact || "").trim();
    const normalized = normalizeContact(trimmedContact, contactType);
    const trimmedName = String(name || "").trim();

    if (!trimmedName || !normalized) {
      return res.status(400).json({ error: "Missing name or contact." });
    }

    let invite = db.findInvite(group.id, normalized, contactType);
    const isFirstMember = db.listMembers(group.id).length === 0;

    if (!invite && isFirstMember) {
      const createdAt = nowIso();
      const selfInviteId = createId();
      db.insertInvites(group.id, [
        {
          id: selfInviteId,
          type: contactType,
          value: trimmedContact,
          normalized,
          status: "pending",
          createdAt,
        },
      ]);
      invite = db.findInvite(group.id, normalized, contactType);
    }

    if (!invite) {
      return res.status(403).json({
        error: "That contact was not invited yet. Ask the host to add you.",
      });
    }
    if (invite.status === "joined") {
      return res.status(403).json({ error: "That contact already joined." });
    }

    const member = db.createMember({
      id: createId(),
      groupId: group.id,
      name: trimmedName,
      type: contactType,
      contact: invite.value,
      joinedAt: nowIso(),
    });

    db.markInviteJoined(invite.id, nowIso());

    return res.json({
      group,
      member,
      members: db.listMembers(group.id),
    });
  });

  app.get("/api/groups/:code/members", (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }
    return res.json({ members: db.listMembers(group.id) });
  });

  app.get("/api/groups/:code/restaurants", (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }
    return res.json({ restaurants: db.listRestaurants(group.id) });
  });

  app.post(
    "/api/groups/:code/restaurants",
    restaurantLimiter,
    async (req, res) => {
      const group = db.getGroupByCode(req.params.code);
      if (!group) {
        return res.status(404).json({ error: "Group not found." });
      }

      const controller = new AbortController();
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          const error = new Error("Restaurant lookup timed out.");
          error.name = "Timeout";
          reject(error);
        }, restaurantTimeoutMs);
      });

      try {
        const restaurants = await Promise.race([
          fetchRestaurants(group.locationValue, group.radius, controller.signal),
          timeoutPromise,
        ]);
        db.storeRestaurants(group.id, restaurants);
        const storedRestaurants = db.listRestaurants(group.id);
        clearTimeout(timeoutId);
        return res.json({
          restaurants: storedRestaurants,
          status: "success",
          summary: summarizeVotes({}, storedRestaurants),
        });
      } catch (error) {
        clearTimeout(timeoutId);
        console.error("restaurant lookup failed", {
          groupId: group.id,
          groupCode: group.code,
          locationValue: group.locationValue,
          radius: group.radius,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
        });
        if (error instanceof Error && error.name === "NoResults") {
          db.storeRestaurants(group.id, []);
          return res.json({
            restaurants: [],
            status: "empty",
            summary: {},
            error: error.message,
          });
        }
        if (error instanceof Error && error.name === "Timeout") {
          return res.status(504).json({ error: error.message });
        }
        return res.status(502).json({
          error:
            error instanceof Error
              ? error.message
              : "Unable to load restaurants.",
        });
      }
    }
  );

  app.post("/api/groups/:code/votes", async (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

    const { memberId, restaurantId, decision } = req.body;
    const member = memberId ? db.getMemberById(memberId) : null;
    if (!member || member.groupId !== group.id) {
      return res.status(400).json({ error: "Invalid member." });
    }

    const restaurants = db.listRestaurants(group.id);
    if (!restaurants.find((item) => item.id === restaurantId)) {
      return res.status(400).json({ error: "Invalid restaurant." });
    }

    if (group.status === "closed") {
      const summary = summarizeVotes(db.getVoteSummary(group.id), restaurants);
      const members = db.listMembers(group.id);
      const status = computeStatus({
        group,
        membersCount: members.length,
        summary,
        restaurants,
        nowMs,
      });
      return res.json({ summary, status, restaurants });
    }

    if (decision === null) {
      db.deleteVote(group.id, restaurantId, memberId);
    } else if (decision === "yes" || decision === "no") {
      db.upsertVote({
        id: createId(),
        groupId: group.id,
        restaurantId,
        memberId,
        decision,
        createdAt: nowIso(),
      });
    } else {
      return res.status(400).json({ error: "Invalid vote decision." });
    }

    const members = db.listMembers(group.id);
    const rawSummary = db.getVoteSummary(group.id);
    const summary = summarizeVotes(rawSummary, restaurants);
    const status = computeStatus({
      group,
      membersCount: members.length,
      summary,
      restaurants,
      nowMs,
    });

    const finalized = await finalizeGroupIfNeeded({
      group,
      members,
      restaurants,
      summary,
      status,
    });

    return res.json({
      summary,
      status: finalized.status,
      restaurants,
      group: finalized.group,
    });
  });

  app.post("/api/groups/:code/close", async (req, res) => {
    const group = db.getGroupByCode(req.params.code);
    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

    const members = db.listMembers(group.id);
    const restaurants = db.listRestaurants(group.id);
    const summary = summarizeVotes(db.getVoteSummary(group.id), restaurants);
    const status = computeStatus({
      group,
      membersCount: members.length,
      summary,
      restaurants,
      nowMs,
    });

    const finalized = await finalizeGroupIfNeeded({
      group,
      members,
      restaurants,
      summary,
      status,
    });

    return res.json({
      summary,
      status: finalized.status,
      restaurants,
      group: finalized.group,
    });
  });

  if (clientDistExists(clientDist)) {
    app.use(express.static(clientDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  return app;
};
