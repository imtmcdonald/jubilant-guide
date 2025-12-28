import { afterEach, describe, expect, it, vi } from "vitest";

const withFreshModule = async (setupEnv) => {
  vi.resetModules();
  setupEnv?.();
  return await import("./notifications.js");
};

const stubFetch = (impl) => {
  vi.stubGlobal("fetch", vi.fn(impl));
  return globalThis.fetch;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifications", () => {
  it("skips email when disabled", async () => {
    const mod = await withFreshModule(() => {
      process.env.APP_BASE_URL = "";
      process.env.EMAIL_FROM = "";
      process.env.ENABLE_EMAIL = "false";
      process.env.ENABLE_SMS = "false";
      delete process.env.RESEND_API_KEY;
    });

    const result = await mod.sendInviteNotification({
      type: "email",
      to: "test@example.com",
      groupName: "Lunch",
      groupCode: "ABCD12",
    });
    expect(result).toEqual({ status: "skipped", reason: "email_disabled" });
  });

  it("sends email (and surfaces upstream errors)", async () => {
    const fetch = stubFetch(async () => ({
      ok: false,
      text: async () => "bad request",
    }));

    const mod = await withFreshModule(() => {
      process.env.APP_BASE_URL = "http://example.test";
      process.env.EMAIL_FROM = "from@example.test";
      process.env.ENABLE_EMAIL = "true";
      delete process.env.ENABLE_SMS;
      process.env.RESEND_API_KEY = "key";
    });

    await expect(
      mod.sendInviteNotification({
        type: "email",
        to: "test@example.com",
        groupName: "Lunch",
        groupCode: "ABCD12",
      })
    ).rejects.toThrow("bad request");
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockResolvedValueOnce({
      ok: false,
      text: async () => "",
    });
    await expect(
      mod.sendInviteNotification({
        type: "email",
        to: "test@example.com",
        groupName: "Lunch",
        groupCode: "ABCD12",
      })
    ).rejects.toThrow("Email request failed.");

    fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    });
    await expect(
      mod.sendInviteNotification({
        type: "email",
        to: "test@example.com",
        groupName: "Lunch",
        groupCode: "ABCD12",
      })
    ).resolves.toEqual({ status: "sent" });
  });

  it("fails email when RESEND_API_KEY is missing (and defaults ENABLE_EMAIL)", async () => {
    const mod = await withFreshModule(() => {
      delete process.env.ENABLE_EMAIL;
      delete process.env.RESEND_API_KEY;
    });

    await expect(
      mod.sendInviteNotification({
        type: "email",
        to: "test@example.com",
        groupName: "Lunch",
        groupCode: "ABCD12",
      })
    ).rejects.toThrow("RESEND_API_KEY is not configured.");
  });

  it("skips sms when disabled", async () => {
    const mod = await withFreshModule(() => {
      process.env.ENABLE_SMS = "false";
      delete process.env.ENABLE_EMAIL;
    });

    const result = await mod.sendInviteNotification({
      type: "phone",
      to: "5551112222",
      groupName: "Lunch",
      groupCode: "ABCD12",
    });
    expect(result).toEqual({ status: "skipped", reason: "sms_disabled" });
  });

  it("sends sms (and surfaces upstream errors)", async () => {
    const fetch = stubFetch(async () => ({
      ok: false,
      text: async () => "nope",
    }));

    const mod = await withFreshModule(() => {
      process.env.ENABLE_SMS = "true";
      process.env.TWILIO_ACCOUNT_SID = "sid";
      process.env.TWILIO_AUTH_TOKEN = "token";
      process.env.TWILIO_FROM_NUMBER = "+15555550123";
    });

    await expect(
      mod.sendInviteNotification({
        type: "phone",
        to: "+15555550124",
        groupName: "Lunch",
        groupCode: "ABCD12",
      })
    ).rejects.toThrow("nope");

    fetch.mockResolvedValueOnce({
      ok: false,
      text: async () => "",
    });
    await expect(
      mod.sendInviteNotification({
        type: "phone",
        to: "+15555550124",
        groupName: "Lunch",
        groupCode: "ABCD12",
      })
    ).rejects.toThrow("SMS request failed.");

    fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    });
    await expect(
      mod.sendInviteNotification({
        type: "phone",
        to: "+15555550124",
        groupName: "Lunch",
        groupCode: "ABCD12",
      })
    ).resolves.toEqual({ status: "sent" });
  });

  it("fails sms when twilio creds are missing (and defaults ENABLE_SMS)", async () => {
    const mod = await withFreshModule(() => {
      delete process.env.ENABLE_SMS;
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_FROM_NUMBER;
    });

    await expect(
      mod.sendInviteNotification({
        type: "phone",
        to: "5551112222",
        groupName: "Lunch",
        groupCode: "ABCD12",
      })
    ).rejects.toThrow("Twilio credentials are not configured.");
  });

  it("sends (or skips) result notifications", async () => {
    const fetch = stubFetch(async () => ({
      ok: true,
      text: async () => "",
    }));

    const mod = await withFreshModule(() => {
      process.env.ENABLE_EMAIL = "false";
      process.env.ENABLE_SMS = "false";
      process.env.RESEND_API_KEY = "key";
      process.env.TWILIO_ACCOUNT_SID = "sid";
      process.env.TWILIO_AUTH_TOKEN = "token";
      process.env.TWILIO_FROM_NUMBER = "+15555550123";
    });

    await expect(
      mod.sendResultNotification({
        member: { type: "email", contact: "test@example.com" },
        group: { name: "Lunch" },
        restaurant: null,
      })
    ).resolves.toBeUndefined();

    await expect(
      mod.sendResultNotification({
        member: { type: "email", contact: "test@example.com" },
        group: { name: "Lunch" },
        restaurant: { name: "Place", cuisine: "Food" },
      })
    ).resolves.toEqual({ status: "skipped", reason: "email_disabled" });

    await expect(
      mod.sendResultNotification({
        member: { type: "phone", contact: "+15555550124" },
        group: { name: "Lunch" },
        restaurant: { name: "Place", cuisine: "Food" },
      })
    ).resolves.toEqual({ status: "skipped", reason: "sms_disabled" });

    const mod2 = await withFreshModule(() => {
      process.env.ENABLE_EMAIL = "true";
      process.env.ENABLE_SMS = "true";
      process.env.RESEND_API_KEY = "key";
      process.env.TWILIO_ACCOUNT_SID = "sid";
      process.env.TWILIO_AUTH_TOKEN = "token";
      process.env.TWILIO_FROM_NUMBER = "+15555550123";
    });

    await expect(
      mod2.sendResultNotification({
        member: { type: "email", contact: "test@example.com" },
        group: { name: "Lunch" },
        restaurant: { name: "Place", cuisine: "Food" },
      })
    ).resolves.toEqual({ status: "sent" });

    await expect(
      mod2.sendResultNotification({
        member: { type: "phone", contact: "+15555550124" },
        group: { name: "Lunch" },
        restaurant: { name: "Place", cuisine: "Food" },
      })
    ).resolves.toEqual({ status: "sent" });

    expect(fetch).toHaveBeenCalled();
  });
});

