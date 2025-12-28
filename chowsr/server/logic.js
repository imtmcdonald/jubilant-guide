export const createRateLimiter = ({ windowMs, max, nowMs = () => Date.now() }) => {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || "unknown";
    const now = nowMs();
    const bucket = hits.get(key);
    if (!bucket || now > bucket.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      return res.status(429).json({
        error: "Too many requests. Please wait a moment and try again.",
      });
    }
    bucket.count += 1;
    return next();
  };
};

export const normalizeContact = (value, type) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (type === "phone") {
    return trimmed.replace(/[^0-9]/g, "");
  }
  return trimmed.toLowerCase();
};

export const summarizeVotes = (summary, restaurants) => {
  return restaurants.reduce((acc, restaurant) => {
    acc[restaurant.id] = summary[restaurant.id] || { yes: 0, no: 0 };
    return acc;
  }, {});
};

export const computeWinner = (summary, restaurants) => {
  const candidates = restaurants
    .map((restaurant) => {
      const counts = summary[restaurant.id] || { yes: 0, no: 0 };
      return {
        restaurantId: restaurant.id,
        yesCount: counts.yes,
        score: counts.yes - counts.no,
      };
    })
    .filter((item) => item.yesCount > 0);

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.yesCount - a.yesCount);
  return candidates[0].restaurantId;
};

export const computeStatus = ({
  group,
  membersCount,
  summary,
  restaurants,
  nowMs = () => Date.now(),
}) => {
  const threshold = Math.max(1, Math.ceil(membersCount * 0.66));
  const deadlineReached =
    group.deadline && new Date(group.deadline).getTime() <= nowMs();
  let consensusRestaurantId = null;

  restaurants.forEach((restaurant) => {
    const counts = summary[restaurant.id] || { yes: 0, no: 0 };
    if (counts.yes >= threshold && !consensusRestaurantId) {
      consensusRestaurantId = restaurant.id;
    }
  });

  let winnerRestaurantId = group.decidedRestaurantId || null;
  if (!winnerRestaurantId && consensusRestaurantId) {
    winnerRestaurantId = consensusRestaurantId;
  }
  if (!winnerRestaurantId && deadlineReached && membersCount > 0) {
    winnerRestaurantId = computeWinner(summary, restaurants);
  }

  const votingComplete =
    group.status === "closed" ||
    (membersCount > 0 && (deadlineReached || Boolean(consensusRestaurantId)));

  return {
    threshold,
    deadlineReached,
    consensusRestaurantId,
    winnerRestaurantId,
    votingComplete,
  };
};

