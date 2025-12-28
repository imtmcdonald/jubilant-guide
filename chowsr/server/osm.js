const geocodeCache = new Map();
const restaurantCache = new Map();

const GEO_TTL_MS = 6 * 60 * 60 * 1000;
const RESTAURANT_TTL_MS = 10 * 60 * 1000;

const USER_AGENT =
  process.env.OSM_USER_AGENT || "chowsr/1.0 (support@chowsr.app)";

const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

const OVERPASS_URLS = (process.env.OVERPASS_URLS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const resolveOverpassUrls = () =>
  OVERPASS_URLS.length ? OVERPASS_URLS : DEFAULT_OVERPASS_URLS;

const cacheGet = (map, key) => {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }
  return hit.value;
};

const cacheSet = (map, key, value, ttl) => {
  map.set(key, { value, expiresAt: Date.now() + ttl });
};

const buildCuisineLabel = (tags) => {
  if (!tags?.cuisine) return "Restaurant";
  const parts = tags.cuisine
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts.slice(0, 2).join(", ") : "Restaurant";
};

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const haversineMiles = (lat1, lon1, lat2, lon2) => {
  const earthRadiusMiles = 3958.8;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const startLat = toRadians(lat1);
  const endLat = toRadians(lat2);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
};

const formatDistance = (miles) => `${miles.toFixed(1)} mi`;

export const geocodeLocation = async (locationValue, signal) => {
  const trimmed = locationValue.trim();
  const cacheKey = trimmed.toLowerCase();
  const cached = cacheGet(geocodeCache, cacheKey);
  if (cached) return cached;

  const geocodeUrl = new URL(
    "https://nominatim.openstreetmap.org/search"
  );
  geocodeUrl.searchParams.set("format", "json");
  geocodeUrl.searchParams.set("limit", "1");
  geocodeUrl.searchParams.set("q", trimmed);

  const response = await fetch(geocodeUrl.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en",
    },
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(
      `Unable to find that location (geocode ${response.status}).${
        errorText ? ` ${errorText.slice(0, 200)}` : ""
      }`
    );
    error.name = "NoResults";
    throw error;
  }

  const data = await response.json();
  if (!Array.isArray(data) || !data.length) {
    const error = new Error("No results for that location.");
    error.name = "NoResults";
    throw error;
  }

  const result = {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
  };
  cacheSet(geocodeCache, cacheKey, result, GEO_TTL_MS);
  return result;
};

export const fetchRestaurants = async (
  locationValue,
  radiusMiles,
  signal,
  options = {}
) => {
  const cacheKey = `${locationValue.toLowerCase()}::${radiusMiles}`;
  const cached = cacheGet(restaurantCache, cacheKey);
  if (cached) return cached;

  const center = await geocodeLocation(locationValue, signal);
  const radiusMeters = Math.round(Number(radiusMiles) * 1609.34);

  const overpassQuery = `
[out:json][timeout:25];
(
  node["amenity"="restaurant"](around:${radiusMeters},${center.lat},${center.lon});
  way["amenity"="restaurant"](around:${radiusMeters},${center.lat},${center.lon});
  relation["amenity"="restaurant"](around:${radiusMeters},${center.lat},${center.lon});
);
out center 40;`;

  let overpassResponse = null;
  let lastError = null;
  const overpassUrls = options.overpassUrls ?? resolveOverpassUrls();

  for (const overpassUrl of overpassUrls) {
    try {
      const response = await fetch(overpassUrl, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: `data=${encodeURIComponent(overpassQuery)}`,
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const error = new Error(
          `Overpass error (${response.status}) from ${overpassUrl}.${
            errorText ? ` ${errorText.slice(0, 200)}` : ""
          }`
        );
        error.name = "UpstreamError";
        throw error;
      }

      overpassResponse = response;
      lastError = null;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Fetch failed.");
    }
  }

  if (!overpassResponse) {
    throw (
      lastError ||
      new Error("Unable to load nearby restaurants (no overpass backends).")
    );
  }

  const overpass = await overpassResponse.json();
  const elements = Array.isArray(overpass.elements) ? overpass.elements : [];
  const seen = new Set();

  const restaurants = elements
    .map((element) => {
      const tags = element.tags || {};
      const name = tags.name || tags.brand;
      if (!name) return null;
      const lat = element.lat ?? element.center?.lat;
      const lon = element.lon ?? element.center?.lon;
      if (lat == null || lon == null) return null;
      const distance = haversineMiles(center.lat, center.lon, lat, lon);
      const normalizedName = name.trim().toLowerCase();
      if (seen.has(normalizedName)) return null;
      seen.add(normalizedName);
      return {
        id: `${element.type}-${element.id}`,
        name: name.trim(),
        cuisine: buildCuisineLabel(tags),
        distanceMiles: distance,
        distance: formatDistance(distance),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 12);

  if (!restaurants.length) {
    const error = new Error("No restaurants found within that radius.");
    error.name = "NoResults";
    throw error;
  }

  cacheSet(restaurantCache, cacheKey, restaurants, RESTAURANT_TTL_MS);
  return restaurants;
};
