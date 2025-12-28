const baseUrl = process.env.APP_BASE_URL || "http://localhost:5173";
const emailFrom = process.env.EMAIL_FROM || "chowsr <hello@chowsr.app>";

const resendApiKey = process.env.RESEND_API_KEY;
const twilioSid = process.env.TWILIO_ACCOUNT_SID;
const twilioToken = process.env.TWILIO_AUTH_TOKEN;
const twilioFrom = process.env.TWILIO_FROM_NUMBER;

const emailEnabled = (process.env.ENABLE_EMAIL ?? "true").toLowerCase() === "true";
const smsEnabled = (process.env.ENABLE_SMS ?? "true").toLowerCase() === "true";

const sendEmail = async ({ to, subject, html, text }) => {
  if (!resendApiKey) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom,
      to,
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Email request failed.");
  }
};

const sendSms = async ({ to, body }) => {
  if (!twilioSid || !twilioToken || !twilioFrom) {
    throw new Error("Twilio credentials are not configured.");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: to,
      From: twilioFrom,
      Body: body,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "SMS request failed.");
  }
};

export const sendInviteNotification = async ({
  type,
  to,
  groupName,
  groupCode,
}) => {
  const joinUrl = `${baseUrl}/?code=${groupCode}`;
  const subject = `You're invited to ${groupName} on chowsr`;
  const text = `You've been invited to join "${groupName}" on chowsr.\n\nJoin with code: ${groupCode}\nOpen: ${joinUrl}`;
  const html = `
    <p>You've been invited to join <strong>${groupName}</strong> on chowsr.</p>
    <p><strong>Group code:</strong> ${groupCode}</p>
    <p><a href="${joinUrl}">Join this group</a></p>
  `;

  if (type === "email") {
    if (!emailEnabled) {
      return { status: "skipped", reason: "email_disabled" };
    }
    await sendEmail({ to, subject, html, text });
    return { status: "sent" };
  }

  if (!smsEnabled) {
    return { status: "skipped", reason: "sms_disabled" };
  }
  const smsBody = `chowsr invite: ${groupName}. Code ${groupCode}. ${joinUrl}`;
  await sendSms({ to, body: smsBody });
  return { status: "sent" };
};

export const sendResultNotification = async ({
  member,
  group,
  restaurant,
}) => {
  if (!restaurant) return;
  const subject = `chowsr decision for ${group.name}`;
  const text = `Voting is complete for "${group.name}". You're eating at ${restaurant.name} (${restaurant.cuisine}).`;
  const html = `
    <p>Voting is complete for <strong>${group.name}</strong>.</p>
    <p>You're eating at <strong>${restaurant.name}</strong> (${restaurant.cuisine}).</p>
  `;

  if (member.type === "email") {
    if (!emailEnabled) {
      return { status: "skipped", reason: "email_disabled" };
    }
    await sendEmail({ to: member.contact, subject, html, text });
    return { status: "sent" };
  }

  if (!smsEnabled) {
    return { status: "skipped", reason: "sms_disabled" };
  }
  const smsBody = `chowsr: ${group.name} is going to ${restaurant.name}.`;
  await sendSms({ to: member.contact, body: smsBody });
  return { status: "sent" };
};
