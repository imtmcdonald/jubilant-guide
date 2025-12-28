import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const migrate = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location_type TEXT NOT NULL,
      location_value TEXT NOT NULL,
      radius INTEGER NOT NULL,
      deadline TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      decided_restaurant_id TEXT,
      decided_at TEXT,
      result_sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      normalized TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      joined_at TEXT,
      error TEXT,
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      contact TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );

    CREATE TABLE IF NOT EXISTS restaurants (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cuisine TEXT NOT NULL,
      distance_miles REAL NOT NULL,
      distance TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES groups(id),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
      FOREIGN KEY (member_id) REFERENCES members(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS votes_unique
      ON votes (group_id, restaurant_id, member_id);
  `);
};

const mapGroup = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    locationType: row.location_type,
    locationValue: row.location_value,
    radius: row.radius,
    deadline: row.deadline,
    createdAt: row.created_at,
    status: row.status,
    decidedRestaurantId: row.decided_restaurant_id,
    decidedAt: row.decided_at,
    resultSentAt: row.result_sent_at,
  };
};

const mapInvite = (row) => ({
  id: row.id,
  groupId: row.group_id,
  type: row.type,
  value: row.value,
  normalized: row.normalized,
  status: row.status,
  createdAt: row.created_at,
  sentAt: row.sent_at,
  joinedAt: row.joined_at,
  error: row.error,
});

const mapMember = (row) => ({
  id: row.id,
  groupId: row.group_id,
  name: row.name,
  type: row.type,
  contact: row.contact,
  joinedAt: row.joined_at,
});

const mapRestaurant = (row) => ({
  id: row.id,
  groupId: row.group_id,
  name: row.name,
  cuisine: row.cuisine,
  distanceMiles: row.distance_miles,
  distance: row.distance,
});

export const createDbApi = (options = {}) => {
  const dbPath =
    options.dbPath ||
    process.env.DB_PATH ||
    path.join(process.cwd(), "data", "chowsr.db");

  const dir = path.dirname(dbPath);
  if (dbPath !== ":memory:" && dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  migrate(db);

  const createGroup = (group) => {
    const normalizedCode = String(group.code).toUpperCase();
    db.prepare(
      `INSERT INTO groups
        (id, code, name, location_type, location_value, radius, deadline, created_at, status)
       VALUES
        (@id, @code, @name, @locationType, @locationValue, @radius, @deadline, @createdAt, @status)`
    ).run({ ...group, code: normalizedCode });
    return getGroupByCode(normalizedCode);
  };

  const getGroupByCode = (code) => {
    const row = db
      .prepare("SELECT * FROM groups WHERE code = ?")
      .get(code.toUpperCase());
    return mapGroup(row);
  };

  const getGroupById = (id) => {
    const row = db.prepare("SELECT * FROM groups WHERE id = ?").get(id);
    return mapGroup(row);
  };

  const updateGroupDecision = (groupId, decision) => {
    db.prepare(
      `UPDATE groups
       SET status = @status,
           decided_restaurant_id = @decidedRestaurantId,
           decided_at = @decidedAt
       WHERE id = @groupId`
    ).run({
      groupId,
      status: decision.status,
      decidedRestaurantId: decision.decidedRestaurantId,
      decidedAt: decision.decidedAt,
    });
    return getGroupById(groupId);
  };

  const markResultSent = (groupId, sentAt) => {
    db.prepare("UPDATE groups SET result_sent_at = ? WHERE id = ?").run(
      sentAt,
      groupId
    );
  };

  const listInvites = (groupId) => {
    const rows = db
      .prepare("SELECT * FROM invites WHERE group_id = ? ORDER BY created_at")
      .all(groupId);
    return rows.map(mapInvite);
  };

  const insertInvites = (groupId, invites) => {
    const stmt = db.prepare(
      `INSERT INTO invites
        (id, group_id, type, value, normalized, status, created_at)
       VALUES
        (@id, @groupId, @type, @value, @normalized, @status, @createdAt)`
    );
    const insert = db.transaction((rows) => {
      rows.forEach((invite) => stmt.run(invite));
    });
    insert(
      invites.map((invite) => ({
        ...invite,
        groupId,
      }))
    );
    return listInvites(groupId);
  };

  const updateInviteStatus = (inviteId, status, sentAt, error) => {
    db.prepare(
      "UPDATE invites SET status = ?, sent_at = ?, error = ? WHERE id = ?"
    ).run(status, sentAt, error ?? null, inviteId);
  };

  const markInviteJoined = (inviteId, joinedAt) => {
    db.prepare("UPDATE invites SET status = ?, joined_at = ? WHERE id = ?").run(
      "joined",
      joinedAt,
      inviteId
    );
  };

  const deleteInvite = (groupId, inviteId) => {
    const invite = db
      .prepare("SELECT * FROM invites WHERE id = ? AND group_id = ?")
      .get(inviteId, groupId);
    if (!invite || invite.status === "joined") return null;
    db.prepare("DELETE FROM invites WHERE id = ?").run(inviteId);
    return mapInvite(invite);
  };

  const findInvite = (groupId, normalized, type) => {
    const row = db
      .prepare(
        "SELECT * FROM invites WHERE group_id = ? AND normalized = ? AND type = ?"
      )
      .get(groupId, normalized, type);
    return row ? mapInvite(row) : null;
  };

  const createMember = (member) => {
    db.prepare(
      `INSERT INTO members
        (id, group_id, name, type, contact, joined_at)
       VALUES
        (@id, @groupId, @name, @type, @contact, @joinedAt)`
    ).run(member);
    return getMemberById(member.id);
  };

  const getMemberById = (memberId) => {
    const row = db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
    return row ? mapMember(row) : null;
  };

  const listMembers = (groupId) => {
    const rows = db
      .prepare("SELECT * FROM members WHERE group_id = ? ORDER BY joined_at")
      .all(groupId);
    return rows.map(mapMember);
  };

  const storeRestaurants = (groupId, restaurants) => {
    const insertRestaurant = db.prepare(
      `INSERT INTO restaurants
        (id, group_id, name, cuisine, distance_miles, distance)
       VALUES
        (@id, @groupId, @name, @cuisine, @distanceMiles, @distance)`
    );
    const toScopedId = (restaurantId) => `${groupId}:${restaurantId}`;
    const tx = db.transaction((list) => {
      db.prepare("DELETE FROM votes WHERE group_id = ?").run(groupId);
      db.prepare("DELETE FROM restaurants WHERE group_id = ?").run(groupId);
      list.forEach((restaurant) =>
        insertRestaurant.run({
          ...restaurant,
          id: toScopedId(restaurant.id),
          groupId,
        })
      );
    });
    tx(restaurants);
  };

  const listRestaurants = (groupId) => {
    const rows = db
      .prepare("SELECT * FROM restaurants WHERE group_id = ?")
      .all(groupId);
    return rows.map(mapRestaurant);
  };

  const upsertVote = (vote) => {
    db.prepare(
      `INSERT INTO votes
        (id, group_id, restaurant_id, member_id, decision, created_at)
       VALUES
        (@id, @groupId, @restaurantId, @memberId, @decision, @createdAt)
       ON CONFLICT(group_id, restaurant_id, member_id)
       DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`
    ).run(vote);
  };

  const deleteVote = (groupId, restaurantId, memberId) => {
    db.prepare(
      "DELETE FROM votes WHERE group_id = ? AND restaurant_id = ? AND member_id = ?"
    ).run(groupId, restaurantId, memberId);
  };

  const getVoteSummary = (groupId) => {
    const rows = db
      .prepare(
        `SELECT restaurant_id,
                SUM(CASE WHEN decision = 'yes' THEN 1 ELSE 0 END) AS yes_count,
                SUM(CASE WHEN decision = 'no' THEN 1 ELSE 0 END) AS no_count
         FROM votes
         WHERE group_id = ?
         GROUP BY restaurant_id`
      )
      .all(groupId);
    return rows.reduce((acc, row) => {
      acc[row.restaurant_id] = {
        yes: Number(row.yes_count),
        no: Number(row.no_count),
      };
      return acc;
    }, {});
  };

  const countMembers = (groupId) => {
    const row = db
      .prepare("SELECT COUNT(*) as count FROM members WHERE group_id = ?")
      .get(groupId);
    return row.count;
  };

  return {
    db,
    close: () => db.close(),

    createGroup,
    getGroupByCode,
    getGroupById,
    updateGroupDecision,
    markResultSent,
    listInvites,
    insertInvites,
    updateInviteStatus,
    markInviteJoined,
    deleteInvite,
    findInvite,
    createMember,
    getMemberById,
    listMembers,
    storeRestaurants,
    listRestaurants,
    upsertVote,
    deleteVote,
    getVoteSummary,
    countMembers,
  };
};

const defaultApi = createDbApi();

export const createGroup = defaultApi.createGroup;
export const getGroupByCode = defaultApi.getGroupByCode;
export const getGroupById = defaultApi.getGroupById;
export const updateGroupDecision = defaultApi.updateGroupDecision;
export const markResultSent = defaultApi.markResultSent;
export const listInvites = defaultApi.listInvites;
export const insertInvites = defaultApi.insertInvites;
export const updateInviteStatus = defaultApi.updateInviteStatus;
export const markInviteJoined = defaultApi.markInviteJoined;
export const deleteInvite = defaultApi.deleteInvite;
export const findInvite = defaultApi.findInvite;
export const createMember = defaultApi.createMember;
export const getMemberById = defaultApi.getMemberById;
export const listMembers = defaultApi.listMembers;
export const storeRestaurants = defaultApi.storeRestaurants;
export const listRestaurants = defaultApi.listRestaurants;
export const upsertVote = defaultApi.upsertVote;
export const deleteVote = defaultApi.deleteVote;
export const getVoteSummary = defaultApi.getVoteSummary;
export const countMembers = defaultApi.countMembers;

export default defaultApi.db;
