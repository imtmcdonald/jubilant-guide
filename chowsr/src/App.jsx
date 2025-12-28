import { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "chowsr_ui_v1";

const FALLBACK_RESTAURANTS = [
  {
    id: "sample-1",
    name: "Golden Spoon",
    cuisine: "Modern American",
    distance: "2.1 mi",
  },
  {
    id: "sample-2",
    name: "Mango Garden",
    cuisine: "Thai",
    distance: "1.4 mi",
  },
  {
    id: "sample-3",
    name: "Juniper Hearth",
    cuisine: "Farm to Table",
    distance: "3.0 mi",
  },
  {
    id: "sample-4",
    name: "Casa Lita",
    cuisine: "Mexican",
    distance: "2.6 mi",
  },
  {
    id: "sample-5",
    name: "Blue Harbor",
    cuisine: "Seafood",
    distance: "4.2 mi",
  },
  {
    id: "sample-6",
    name: "Saffron Alley",
    cuisine: "Indian",
    distance: "2.9 mi",
  },
];

const loadUiState = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const defaultDeadline = () => {
  const now = new Date();
  now.setHours(now.getHours() + 2);
  return now.toISOString().slice(0, 16);
};

const createId = () => Math.random().toString(36).slice(2, 9);

const normalizeContact = (value, type) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (type === "phone") {
    return trimmed.replace(/[^0-9]/g, "");
  }
  return trimmed.toLowerCase();
};

const formatDate = (value) => {
  if (!value) return "TBD";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "TBD" : date.toLocaleString();
};

const apiRequest = async (path, options = {}) => {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload?.error || payload?.message || "Request failed. Try again.";
    throw new Error(message);
  }

  return payload;
};

export default function App() {
  const saved = loadUiState();
  const [group, setGroup] = useState(null);
  const [groupCode, setGroupCode] = useState(saved?.groupCode ?? "");
  const [invites, setInvites] = useState([]);
  const [members, setMembers] = useState([]);
  const [restaurants, setRestaurants] = useState([]);
  const [summary, setSummary] = useState({});
  const [status, setStatus] = useState({});
  const [activeMemberId, setActiveMemberId] = useState(
    saved?.activeMemberId ?? ""
  );
  const [memberVotes, setMemberVotes] = useState({});
  const [restaurantStatus, setRestaurantStatus] = useState("idle");
  const [restaurantError, setRestaurantError] = useState("");
  const [isLoadingGroup, setIsLoadingGroup] = useState(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [isSendingInvites, setIsSendingInvites] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  const [groupDraft, setGroupDraft] = useState({
    name: "",
    locationType: "city",
    locationValue: "",
    radius: 5,
    deadline: defaultDeadline(),
  });
  const [inviteDraft, setInviteDraft] = useState({
    type: "email",
    value: "",
  });
  const [joinDraft, setJoinDraft] = useState({
    name: "",
    type: "email",
    contact: "",
    code: saved?.groupCode ?? "",
  });
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const closeTriggered = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ groupCode, activeMemberId })
    );
  }, [groupCode, activeMemberId]);

  useEffect(() => {
    if (group?.code && joinDraft.code !== group.code) {
      setJoinDraft((prev) => ({ ...prev, code: group.code }));
    }
  }, [group?.code, joinDraft.code]);

  useEffect(() => {
    if (activeMemberId) {
      setMemberVotes({});
    }
  }, [activeMemberId]);

  const loadGroupState = async (code) => {
    if (!code) return;
    setError("");
    setIsLoadingGroup(true);
    try {
      const data = await apiRequest(`/api/groups/${code}/state`);
      setGroup(data.group);
      setGroupCode(data.group.code);
      setInvites(data.invites || []);
      setMembers(data.members || []);
      setRestaurants(data.restaurants || []);
      setSummary(data.summary || {});
      setStatus(data.status || {});
      setRestaurantStatus(data.restaurants?.length ? "success" : "idle");
      setRestaurantError("");
      if (
        activeMemberId &&
        !data.members?.some((member) => member.id === activeMemberId)
      ) {
        setActiveMemberId("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load group.");
    } finally {
      setIsLoadingGroup(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code && !group) {
      const normalizedCode = code.trim().toUpperCase();
      setJoinDraft((prev) => ({ ...prev, code: normalizedCode }));
      loadGroupState(normalizedCode);
    }
  }, [group]);

  const refreshRestaurants = async (overrideCode) => {
    const code = overrideCode || group?.code;
    if (!code) return;
    setIsRefreshing(true);
    setRestaurantStatus("loading");
    setRestaurantError("");
    try {
      const data = await apiRequest(`/api/groups/${code}/restaurants`, {
        method: "POST",
      });
      setRestaurants(data.restaurants || []);
      setSummary(data.summary || {});
      setRestaurantStatus(data.status || "success");
      setRestaurantError(data.error ? String(data.error) : "");
      setMemberVotes({});
    } catch (err) {
      setRestaurantError(
        err instanceof Error ? err.message : "Unable to load restaurants."
      );
      setRestaurants(FALLBACK_RESTAURANTS);
      setRestaurantStatus("fallback");
    } finally {
      setIsRefreshing(false);
    }
  };

  const sendInvites = async (inviteList, overrideCode) => {
    const code = overrideCode || group?.code;
    if (!code || !inviteList.length) return;
    setIsSendingInvites(true);
    setError("");
    try {
      const payload = {
        invites: inviteList.map((invite) => ({
          type: invite.type,
          value: invite.value,
        })),
      };
      const data = await apiRequest(`/api/groups/${code}/invites`, {
        method: "POST",
        body: payload,
      });
      setInvites(data.invites || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite send failed.");
    } finally {
      setIsSendingInvites(false);
    }
  };

  const handleCreateGroup = async () => {
    setError("");
    if (!groupDraft.name.trim()) {
      setError("Add a group name.");
      return;
    }
    if (!groupDraft.locationValue.trim()) {
      setError("Add a location.");
      return;
    }
    if (Number(groupDraft.radius) <= 0) {
      setError("Radius must be greater than zero.");
      return;
    }
    if (!groupDraft.deadline) {
      setError("Add a voting deadline.");
      return;
    }

    setIsCreatingGroup(true);
    try {
      const data = await apiRequest("/api/groups", {
        method: "POST",
        body: groupDraft,
      });
      setGroup(data.group);
      setGroupCode(data.group.code);
      setMembers([]);
      setSummary({});
      setStatus({});
      setRestaurants([]);
      setActiveMemberId("");
      setRestaurantStatus("loading");
      closeTriggered.current = false;

      const pendingInvites = invites.filter(
        (invite) => invite.status === "draft"
      );
      if (pendingInvites.length) {
        await sendInvites(pendingInvites, data.group.code);
      }
      await refreshRestaurants(data.group.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Group creation failed.");
    } finally {
      setIsCreatingGroup(false);
    }
  };

  const handleAddInvite = async () => {
    setError("");
    const normalized = normalizeContact(inviteDraft.value, inviteDraft.type);
    if (!normalized) {
      setError("Enter a valid email or phone number.");
      return;
    }
    const exists = invites.some(
      (invite) =>
        invite.normalized === normalized && invite.type === inviteDraft.type
    );
    if (exists) {
      setError("That invite already exists.");
      return;
    }

    const entry = {
      id: createId(),
      type: inviteDraft.type,
      value: inviteDraft.value.trim(),
      normalized,
      status: group ? "pending" : "draft",
    };
    setInviteDraft((prev) => ({ ...prev, value: "" }));

    if (!group) {
      setInvites((prev) => [...prev, entry]);
      return;
    }

    await sendInvites([entry]);
  };

  const handleRemoveInvite = async (inviteId, statusValue) => {
    if (!group || statusValue === "draft") {
      setInvites((prev) => prev.filter((invite) => invite.id !== inviteId));
      return;
    }
    try {
      const data = await apiRequest(
        `/api/groups/${group.code}/invites/${inviteId}`,
        { method: "DELETE" }
      );
      setInvites(data.invites || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove invite.");
    }
  };

  const handleLoadGroup = async () => {
    const code = joinDraft.code.trim().toUpperCase();
    if (!code) {
      setError("Enter a group code.");
      return;
    }
    await loadGroupState(code);
  };

  const handleJoin = async () => {
    setError("");
    const code = (group?.code || joinDraft.code).trim().toUpperCase();
    if (!code) {
      setError("Enter a group code.");
      return;
    }
    if (!joinDraft.name.trim()) {
      setError("Enter your name.");
      return;
    }
    if (!normalizeContact(joinDraft.contact, joinDraft.type)) {
      setError("Enter the invited email or phone number.");
      return;
    }

    setIsJoining(true);
    try {
      const data = await apiRequest(`/api/groups/${code}/join`, {
        method: "POST",
        body: {
          name: joinDraft.name,
          type: joinDraft.type,
          contact: joinDraft.contact,
        },
      });
      setGroup(data.group);
      setGroupCode(data.group.code);
      setMembers(data.members || []);
      setActiveMemberId(data.member?.id || "");
      await loadGroupState(code);
      setJoinDraft((prev) => ({
        ...prev,
        name: "",
        contact: "",
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join.");
    } finally {
      setIsJoining(false);
    }
  };

  const handleVote = async (restaurantId, decision) => {
    if (!activeMemberId || !group || status.votingComplete) return;
    const current = memberVotes[restaurantId] || null;
    const nextDecision = current === decision ? null : decision;
    setMemberVotes((prev) => ({
      ...prev,
      [restaurantId]: nextDecision,
    }));

    try {
      const data = await apiRequest(`/api/groups/${group.code}/votes`, {
        method: "POST",
        body: {
          memberId: activeMemberId,
          restaurantId,
          decision: nextDecision,
        },
      });
      setSummary(data.summary || {});
      setStatus(data.status || {});
      if (data.group) {
        setGroup(data.group);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vote failed.");
    }
  };

  const handleClose = async () => {
    if (!group || status.votingComplete) return;
    try {
      const data = await apiRequest(`/api/groups/${group.code}/close`, {
        method: "POST",
      });
      setSummary(data.summary || {});
      setStatus(data.status || {});
      if (data.group) {
        setGroup(data.group);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to close voting.");
    }
  };

  const resetAll = () => {
    setGroup(null);
    setGroupCode("");
    setInvites([]);
    setMembers([]);
    setRestaurants([]);
    setSummary({});
    setStatus({});
    setActiveMemberId("");
    setMemberVotes({});
    setRestaurantStatus("idle");
    setRestaurantError("");
    setGroupDraft({
      name: "",
      locationType: "city",
      locationValue: "",
      radius: 5,
      deadline: defaultDeadline(),
    });
    setInviteDraft({ type: "email", value: "" });
    setJoinDraft({ name: "", type: "email", contact: "", code: "" });
    setError("");
    closeTriggered.current = false;
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const consensusThreshold = status.threshold
    ? status.threshold
    : Math.max(1, Math.ceil(members.length * 0.66));

  const voteStats = useMemo(() => {
    return restaurants.map((restaurant) => {
      const counts = summary[restaurant.id] || { yes: 0, no: 0 };
      const yesCount = counts.yes || 0;
      const noCount = counts.no || 0;
      const pendingCount = Math.max(0, members.length - yesCount - noCount);
      return { restaurant, yesCount, noCount, pendingCount };
    });
  }, [summary, members.length, restaurants]);

  const consensusRestaurant = useMemo(() => {
    if (!status.consensusRestaurantId) return null;
    return restaurants.find(
      (restaurant) => restaurant.id === status.consensusRestaurantId
    );
  }, [status.consensusRestaurantId, restaurants]);

  const winningRestaurant = useMemo(() => {
    if (!status.winnerRestaurantId) return null;
    return restaurants.find(
      (restaurant) => restaurant.id === status.winnerRestaurantId
    );
  }, [status.winnerRestaurantId, restaurants]);

  const deadlineReached =
    group?.deadline && new Date(group.deadline).getTime() <= now;
  const votingComplete = Boolean(status.votingComplete);

  useEffect(() => {
    if (!group || votingComplete) {
      closeTriggered.current = false;
      return;
    }
    if (deadlineReached && !closeTriggered.current) {
      closeTriggered.current = true;
      handleClose();
    }
  }, [deadlineReached, group, votingComplete]);

  const hasGroup = Boolean(group);
  const shareUrl = useMemo(() => {
    if (!group || typeof window === "undefined") return "";
    return `${window.location.origin}/?code=${group.code}`;
  }, [group]);

  const handleCopy = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setToast(`${label} copied.`);
    } catch {
      setError("Unable to copy to clipboard.");
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">chowsr</p>
          <h1>Pick a place together</h1>
          <p className="lead">
            Start a vote, share a code, and let everyone vote "yes/no" on nearby
            restaurants.
          </p>
        </div>
        <div className="top-actions">
          {hasGroup ? (
            <>
              <button
                type="button"
                className="ghost"
                onClick={() => handleCopy(group.code, "Group code")}
              >
                Copy code
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => handleCopy(shareUrl, "Share link")}
                disabled={!shareUrl}
              >
                Copy link
              </button>
              <button
                className="ghost"
                type="button"
                onClick={() => refreshRestaurants()}
                disabled={isRefreshing}
              >
                Refresh restaurants
              </button>
            </>
          ) : null}
          <button
            className={hasGroup ? "ghost" : "primary"}
            type="button"
            onClick={resetAll}
          >
            {hasGroup ? "Start over" : "Reset"}
          </button>
        </div>
      </header>

      {toast ? <div className="toast">{toast}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <main className={hasGroup ? "flow" : "start-grid"}>
        {hasGroup ? (
          <section className="panel group-panel">
            <div className="panel-head">
              <div>
                <h3>{group.name}</h3>
                <p className="muted">
                  {group.locationValue} | {group.radius} mi | deadline{" "}
                  {formatDate(group.deadline)}
                </p>
              </div>
              <div className="group-meta">
                <div>
                  <p className="label">Code</p>
                  <p className="code">{group.code}</p>
                </div>
                <div>
                  <p className="label">Members</p>
                  <p className="value">{members.length}</p>
                </div>
                <div>
                  <p className="label">Invites</p>
                  <p className="value">{invites.length}</p>
                </div>
              </div>
            </div>
            {shareUrl ? (
              <div className="share-row">
                <div>
                  <p className="label">Share link</p>
                  <p className="muted small share-url">{shareUrl}</p>
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => handleCopy(shareUrl, "Share link")}
                >
                  Copy
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
        {!hasGroup ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Create your group</h3>
              <p className="muted">
                Pick a location. We'll generate a group code and pull nearby
                restaurants.
              </p>
            </div>
          </div>
          <div className="form-grid">
            <label>
              Group name
              <input
                type="text"
                value={groupDraft.name}
                onChange={(event) =>
                  setGroupDraft((prev) => ({
                    ...prev,
                    name: event.target.value,
                  }))
                }
                placeholder="Late night team"
              />
            </label>
            <label>
              Location
              <input
                type="text"
                value={groupDraft.locationValue}
                onChange={(event) =>
                  setGroupDraft((prev) => ({
                    ...prev,
                    locationValue: event.target.value,
                  }))
                }
                placeholder="Austin, TX or 78701"
              />
            </label>
          </div>
          <details className="options">
            <summary>Options</summary>
            <div className="form-grid options-grid">
              <label>
                Location type
                <select
                  value={groupDraft.locationType}
                  onChange={(event) =>
                    setGroupDraft((prev) => ({
                      ...prev,
                      locationType: event.target.value,
                    }))
                  }
                >
                  <option value="city">City</option>
                  <option value="zip">Zip code</option>
                  <option value="address">Address</option>
                  <option value="state">State</option>
                </select>
              </label>
              <label>
                Radius (miles)
                <input
                  type="number"
                  min="1"
                  value={groupDraft.radius}
                  onChange={(event) =>
                    setGroupDraft((prev) => ({
                      ...prev,
                      radius: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Voting deadline
                <input
                  type="datetime-local"
                  value={groupDraft.deadline}
                  onChange={(event) =>
                    setGroupDraft((prev) => ({
                      ...prev,
                      deadline: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
          </details>
          <button
            className="primary"
            type="button"
            onClick={handleCreateGroup}
            disabled={isCreatingGroup}
          >
            {isCreatingGroup ? "Creating..." : "Create group"}
          </button>
        </section>
        ) : null}

        {hasGroup ? (
        <details className="panel panel-details" open={!invites.length}>
          <summary className="panel-summary">
            <div>
              <h3>Invite people (optional)</h3>
              <p className="muted">
                Anyone after the first member must be invited to join.
              </p>
            </div>
            <span className="pill">{invites.length} invites</span>
          </summary>
          <div className="invite-row">
            <select
              value={inviteDraft.type}
              onChange={(event) =>
                setInviteDraft((prev) => ({
                  ...prev,
                  type: event.target.value,
                }))
              }
            >
              <option value="email">Email</option>
              <option value="phone">Phone</option>
            </select>
            <input
              type="text"
              value={inviteDraft.value}
              onChange={(event) =>
                setInviteDraft((prev) => ({
                  ...prev,
                  value: event.target.value,
                }))
              }
              placeholder={
                inviteDraft.type === "email"
                  ? "name@email.com"
                  : "(512) 555-0123"
              }
            />
            <button
              type="button"
              onClick={handleAddInvite}
              disabled={isSendingInvites}
            >
              Add invite
            </button>
          </div>
          <div className="invite-list">
            {invites.length ? (
              invites.map((invite) => (
                <div className="invite-item" key={invite.id}>
                  <div>
                    <p className="invite-value">{invite.value}</p>
                    <p className="muted small">
                      {invite.type} - {invite.status}
                    </p>
                    {invite.error ? (
                      <p className="muted small">{invite.error}</p>
                    ) : null}
                  </div>
                  {invite.status !== "joined" ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        handleRemoveInvite(invite.id, invite.status)
                      }
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="muted">
                No invites yet. You can invite people later.
              </p>
            )}
          </div>
        </details>
        ) : null}

        {!hasGroup || !activeMemberId ? (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{hasGroup ? "Join to vote" : "Join a group"}</h3>
                <p className="muted">
                  {hasGroup
                    ? members.length === 0
                      ? "If you're the first member, you can join without an invite. After that, the host must invite you."
                      : "Ask the host to add your email/phone, then join here."
                    : "Enter a code to load the group."}
                </p>
              </div>
            </div>

            {!hasGroup ? (
              <div className="join-actions">
                <label>
                  Group code
                  <input
                    type="text"
                    value={joinDraft.code}
                    onChange={(event) =>
                      setJoinDraft((prev) => ({
                        ...prev,
                        code: event.target.value.toUpperCase(),
                      }))
                    }
                    placeholder="ABC123"
                  />
                </label>
                <button
                  className="primary"
                  type="button"
                  onClick={handleLoadGroup}
                  disabled={isLoadingGroup}
                >
                  {isLoadingGroup ? "Loading..." : "Load group"}
                </button>
              </div>
            ) : (
              <>
                <div className="form-grid">
                  <label>
                    Your name
                    <input
                      type="text"
                      value={joinDraft.name}
                      onChange={(event) =>
                        setJoinDraft((prev) => ({
                          ...prev,
                          name: event.target.value,
                        }))
                      }
                      placeholder="Jordan"
                    />
                  </label>
                  <label>
                    Contact type
                    <select
                      value={joinDraft.type}
                      onChange={(event) =>
                        setJoinDraft((prev) => ({
                          ...prev,
                          type: event.target.value,
                        }))
                      }
                    >
                      <option value="email">Email</option>
                      <option value="phone">Phone</option>
                    </select>
                  </label>
                  <label>
                    Your contact
                    <input
                      type="text"
                      value={joinDraft.contact}
                      onChange={(event) =>
                        setJoinDraft((prev) => ({
                          ...prev,
                          contact: event.target.value,
                        }))
                      }
                      placeholder={
                        joinDraft.type === "email"
                          ? "name@email.com"
                          : "(512) 555-0123"
                      }
                    />
                  </label>
                </div>
                <div className="join-actions">
                  <button
                    className="primary"
                    type="button"
                    onClick={handleJoin}
                    disabled={isJoining}
                  >
                    {isJoining ? "Joining..." : "Join"}
                  </button>
                </div>
              </>
            )}
          </section>
        ) : null}

        {hasGroup ? (
        <section className="panel voting">
          <div className="panel-head">
            <div>
              <h3>Vote on restaurants</h3>
              <p className="muted">
                Consensus triggers at {consensusThreshold}+ yes votes or when
                the deadline passes.
              </p>
              {restaurantStatus === "loading" ? (
                <p className="muted small">Loading restaurants near you...</p>
              ) : null}
              {restaurantStatus === "fallback" ? (
                <p className="muted small">
                  Live data unavailable. Showing sample restaurants.
                </p>
              ) : null}
              {restaurantStatus === "empty" ? (
                <p className="muted small">
                  No restaurants found. Try a larger radius.
                </p>
              ) : null}
              {restaurantError ? (
                <p className="muted small">{restaurantError}</p>
              ) : null}
            </div>
            <div className="vote-meta">
              <p className="muted small">
                Voting {votingComplete ? "closed" : "open"}
              </p>
              <p className="muted small">
                Deadline: {group ? formatDate(group.deadline) : "--"}
              </p>
            </div>
          </div>

          <div className="member-row">
            <label>
              Active member
              <select
                value={activeMemberId}
                onChange={(event) => setActiveMemberId(event.target.value)}
                disabled={!members.length}
              >
                <option value="">Select member</option>
                {members.map((member) => (
                  <option value={member.id} key={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="member-summary">
              <p className="label">Members joined</p>
              <p className="value">{members.length}</p>
            </div>
          </div>

          {restaurants.length ? (
            <div className="cards">
              {voteStats.map((stat) => {
                const currentVote = memberVotes[stat.restaurant.id] || null;
                return (
                  <article className="card" key={stat.restaurant.id}>
                    <div className="card-head">
                      <div>
                        <h4>{stat.restaurant.name}</h4>
                        <p className="muted small">
                          {stat.restaurant.cuisine} - {stat.restaurant.distance}
                        </p>
                      </div>
                      <span className="pill">{stat.restaurant.distance}</span>
                    </div>
                    <div className="card-votes">
                      <div>
                        <p className="label">Yes</p>
                        <p className="value">{stat.yesCount}</p>
                      </div>
                      <div>
                        <p className="label">No</p>
                        <p className="value">{stat.noCount}</p>
                      </div>
                      <div>
                        <p className="label">Pending</p>
                        <p className="value">{stat.pendingCount}</p>
                      </div>
                    </div>
                    <div className="vote-actions">
                      <button
                        type="button"
                        className={
                          currentVote === "yes" ? "vote active" : "vote"
                        }
                        disabled={!activeMemberId || votingComplete}
                        onClick={() => handleVote(stat.restaurant.id, "yes")}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className={
                          currentVote === "no" ? "vote active" : "vote"
                        }
                        disabled={!activeMemberId || votingComplete}
                        onClick={() => handleVote(stat.restaurant.id, "no")}
                      >
                        No
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="result-card">
              <p className="muted">
                {group
                  ? restaurantStatus === "loading"
                    ? "Fetching nearby restaurants..."
                    : restaurantStatus === "empty"
                      ? "No restaurants found for this location."
                      : "Restaurants will appear here once loaded."
                  : "Create or load a group to start voting."}
              </p>
            </div>
          )}
        </section>
        ) : null}

        {hasGroup ? (
        <section className="panel result">
          <div className="panel-head">
            <div>
              <h3>Decision</h3>
              <p className="muted">
                Once voting ends, everyone gets the result.
              </p>
            </div>
          </div>
          {votingComplete ? (
            <div className="result-card">
              <p className="label">Selected restaurant</p>
              <h4>
                {winningRestaurant ? winningRestaurant.name : "No winner yet"}
              </h4>
              <p className="muted small">
                {winningRestaurant
                  ? `${winningRestaurant.cuisine} - ${winningRestaurant.distance}`
                  : "No votes were submitted before the deadline."}
              </p>
              <div className="notification">
                <span className="dot" />
                <p className="muted">
                  Notifications queued for {members.length} members.
                </p>
              </div>
            </div>
          ) : (
            <div className="result-card">
              <p className="muted">
                Voting is open. Once the deadline hits or a consensus is met,
                the chosen restaurant will appear here.
              </p>
              {consensusRestaurant ? (
                <p className="muted small">
                  Consensus reached on {consensusRestaurant.name}.
                </p>
              ) : null}
              {deadlineReached ? (
                <p className="muted small">
                  Deadline reached. Finalizing decision...
                </p>
              ) : null}
            </div>
          )}
        </section>
        ) : null}
      </main>
    </div>
  );
}

