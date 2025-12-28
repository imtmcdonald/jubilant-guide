import { afterEach, describe, expect, it, vi } from "vitest";

const makeResponse = ({ ok, status = 200, json, text }) => ({
  ok,
  status,
  json: json ? async () => json : async () => ({}),
  text: text ? async () => text : async () => "",
});

const withFreshModule = async (setupEnv) => {
  vi.resetModules();
  setupEnv?.();
  return await import("./osm.js");
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("osm", () => {
  it("geocodeLocation throws NoResults for non-OK responses and empty bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ ok: false, status: 500, text: "oops" })));
    const mod = await withFreshModule(() => {});
    await expect(mod.geocodeLocation("Seattle", undefined)).rejects.toMatchObject({
      name: "NoResults",
    });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => {
        throw new Error("nope");
      },
    })));
    const mod2 = await withFreshModule(() => {});
    await expect(mod2.geocodeLocation("Seattle", undefined)).rejects.toMatchObject({
      name: "NoResults",
    });

    vi.stubGlobal("fetch", vi.fn(async () => makeResponse({ ok: true, json: [] })));
    const mod3 = await withFreshModule(() => {});
    await expect(mod3.geocodeLocation("Seattle", undefined)).rejects.toMatchObject({
      name: "NoResults",
    });
  });

  it("geocodeLocation caches and expires results", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const fetch = vi.fn(async () =>
      makeResponse({
        ok: true,
        json: [{ lat: "47.60", lon: "-122.33" }],
      })
    );
    vi.stubGlobal("fetch", fetch);

    const mod = await withFreshModule(() => {});
    const first = await mod.geocodeLocation("Seattle", undefined);
    const second = await mod.geocodeLocation("Seattle", undefined);
    expect(first).toEqual({ lat: 47.6, lon: -122.33 });
    expect(second).toEqual({ lat: 47.6, lon: -122.33 });
    expect(fetch).toHaveBeenCalledTimes(1);

    now = 7 * 60 * 60 * 1000;
    await mod.geocodeLocation("Seattle", undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fetchRestaurants tries multiple overpass backends, filters, sorts, and caches", async () => {
    let calls = 0;
    const fetch = vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.includes("nominatim.openstreetmap.org")) {
        return makeResponse({
          ok: true,
          json: [{ lat: "47.60", lon: "-122.33" }],
        });
      }

      calls += 1;
      if (calls === 1) {
        return makeResponse({ ok: false, status: 502, text: "bad gateway" });
      }
      return makeResponse({
        ok: true,
        json: {
          elements: [
            { type: "node", id: 1, tags: { name: " A ", cuisine: "thai; ramen" }, lat: 47.6, lon: -122.33 },
            { type: "node", id: 2, tags: { name: "A" }, lat: 47.6, lon: -122.33 }, // duplicate (normalized)
            { type: "node", id: 3, tags: { brand: "Bistro" }, lat: 47.61, lon: -122.34 },
            { type: "node", id: 4, tags: { name: "NoCoords" } }, // dropped
            { type: "node", id: 5, tags: {} }, // dropped
            { type: "node", id: 7, tags: null, lat: 47.6, lon: -122.33 }, // dropped (no tags)
            { type: "node", id: 8, tags: { name: "EmptyCuisine", cuisine: " ; " }, lat: 47.605, lon: -122.335 },
            { type: "way", id: 6, tags: { name: "WayPlace" }, center: { lat: 47.62, lon: -122.35 } },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const mod = await withFreshModule(() => {});
    const restaurants = await mod.fetchRestaurants("Seattle", 5, undefined, {
      overpassUrls: ["https://overpass1.test", "https://overpass2.test"],
    });
    expect(restaurants.length).toBeGreaterThan(0);
    expect(restaurants.find((r) => r.name === "EmptyCuisine")?.cuisine).toBe(
      "Restaurant"
    );
    expect(restaurants[0]).toMatchObject({
      id: expect.stringContaining("-"),
      name: expect.any(String),
      cuisine: expect.any(String),
      distance: expect.stringMatching(/ mi$/),
    });

    const cached = await mod.fetchRestaurants("Seattle", 5, undefined, {
      overpassUrls: ["https://overpass1.test", "https://overpass2.test"],
    });
    expect(cached).toEqual(restaurants);
  });

  it("fetchRestaurants throws NoResults when no restaurants are found", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.includes("nominatim.openstreetmap.org")) {
        return makeResponse({
          ok: true,
          json: [{ lat: "47.60", lon: "-122.33" }],
        });
      }
      return makeResponse({ ok: true, json: { elements: null } });
    }));

    const mod = await withFreshModule(() => {});
    await expect(
      mod.fetchRestaurants("Seattle", 5, undefined, { overpassUrls: ["https://x.test"] })
    ).rejects.toMatchObject({ name: "NoResults" });
  });

  it("fetchRestaurants throws when all backends fail (including no backends)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const urlString = String(url);
        if (urlString.includes("nominatim.openstreetmap.org")) {
          return makeResponse({
            ok: true,
            json: [{ lat: "47.60", lon: "-122.33" }],
          });
        }
        return {
          ok: false,
          status: 500,
          text: async () => {
            throw new Error("nope");
          },
          json: async () => ({}),
        };
      })
    );

    const mod = await withFreshModule(() => {});
    await expect(
      mod.fetchRestaurants("Seattle", 5, undefined, { overpassUrls: ["https://a.test"] })
    ).rejects.toThrow("Overpass error");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const urlString = String(url);
        if (urlString.includes("nominatim.openstreetmap.org")) {
          return makeResponse({
            ok: true,
            json: [{ lat: "47.60", lon: "-122.33" }],
          });
        }
        throw "boom";
      })
    );

    const mod2 = await withFreshModule(() => {});
    await expect(
      mod2.fetchRestaurants("Seattle", 5, undefined, { overpassUrls: ["https://a.test"] })
    ).rejects.toThrow("Fetch failed.");

    await expect(
      mod2.fetchRestaurants("Seattle", 5, undefined, { overpassUrls: [] })
    ).rejects.toThrow("no overpass backends");
  });

  it("respects OVERPASS_URLS env when options are not provided", async () => {
    const fetch = vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.includes("nominatim.openstreetmap.org")) {
        return makeResponse({
          ok: true,
          json: [{ lat: "47.60", lon: "-122.33" }],
        });
      }
      expect(urlString).toContain("overpass.custom");
      return makeResponse({
        ok: true,
        json: {
          elements: [
            { type: "node", id: 1, tags: { name: "X" }, lat: 47.6, lon: -122.33 },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const mod = await withFreshModule(() => {
      process.env.OVERPASS_URLS = "https://overpass.custom/api/interpreter";
    });

    const restaurants = await mod.fetchRestaurants("Seattle", 5, undefined);
    expect(restaurants).toHaveLength(1);
  });

  it("uses default overpass URLs when OVERPASS_URLS is empty and options are omitted", async () => {
    const fetch = vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.includes("nominatim.openstreetmap.org")) {
        return makeResponse({
          ok: true,
          json: [{ lat: "47.60", lon: "-122.33" }],
        });
      }
      expect(urlString).toContain("overpass-api.de");
      return makeResponse({
        ok: true,
        json: {
          elements: [
            { type: "node", id: 1, tags: { name: "X" }, lat: 47.6, lon: -122.33 },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const mod = await withFreshModule(() => {
      process.env.OVERPASS_URLS = "";
    });
    const restaurants = await mod.fetchRestaurants("Seattle", 5, undefined);
    expect(restaurants).toHaveLength(1);
  });
});
