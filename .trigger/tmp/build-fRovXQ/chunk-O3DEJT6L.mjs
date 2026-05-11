import {
  createServiceClient,
  getAnalyticsDayRange,
  logger,
  sendEmail
} from "./chunk-4PKXMH3C.mjs";
import {
  __name,
  init_esm
} from "./chunk-ZETKKQG6.mjs";

// agents/followup.ts
init_esm();

// src/lib/utils.ts
init_esm();
function textToHtml(text) {
  return text.split("\n").map((line) => `<p>${line || "&nbsp;"}</p>`).join("");
}
__name(textToHtml, "textToHtml");
var HTML_SIGNOFF = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:15px;">
  <p style="margin:0 0 2px;color:#374151;">Cheers,</p>
  <p style="margin:0 0 2px;font-weight:600;color:#111827;">Owais</p>
  <p style="margin:0 0 12px;color:#374151;">Aussie Venture</p>
  <p style="margin:0 0 3px;font-size:13px;"><a href="mailto:hello@aussieventure.com" style="color:#0ea5e9;text-decoration:none;">hello@aussieventure.com</a></p>
  <p style="margin:0 0 8px;font-size:13px;"><a href="https://aussieventure.com" style="color:#0ea5e9;text-decoration:none;">aussieventure.com</a></p>
  <p style="margin:0;font-size:13px;color:#6b7280;">
    <a href="https://instagram.com/aussie.venture" style="color:#0ea5e9;text-decoration:none;">Instagram</a>&nbsp;&middot;&nbsp;<a href="https://tiktok.com/@aussie.venture" style="color:#0ea5e9;text-decoration:none;">TikTok</a>&nbsp;&middot;&nbsp;<a href="https://facebook.com/AussieVenture" style="color:#0ea5e9;text-decoration:none;">Facebook</a>&nbsp;&middot;&nbsp;<a href="https://facebook.com/Sydneyventure" style="color:#0ea5e9;text-decoration:none;">Sydney Venture</a>
  </p>
</div>`;
function emailBodyToHtml(plainText) {
  const signoffIdx = plainText.indexOf("Cheers,");
  const bodyOnly = (signoffIdx >= 0 ? plainText.slice(0, signoffIdx) : plainText).trim();
  const paragraphs = bodyOnly.split(/\n\n+/).filter(Boolean).map((p) => `<p style="margin:0 0 18px;color:#374151;font-size:15px;line-height:1.75;">${p.trim()}</p>`).join("\n");
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;">
${paragraphs}
${HTML_SIGNOFF}
</div>`;
}
__name(emailBodyToHtml, "emailBodyToHtml");

// agents/followup.ts
var FOLLOW_UP_LIMIT_KEYS = {
  follow_up_1: "daily_followup1_limit",
  follow_up_2: "daily_followup2_limit",
  follow_up_3: "daily_followup3_limit"
};
var FOLLOW_UP_DEFAULT_LIMITS = {
  follow_up_1: 20,
  follow_up_2: 10,
  follow_up_3: 5
};
async function sentTodayCount(supabase, type, range) {
  const { count } = await supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "sent").eq("type", type).gte("sent_at", range.start).lt("sent_at", range.end);
  return count ?? 0;
}
__name(sentTodayCount, "sentTodayCount");
function buildFollowUpEmail(type, leadName, initialSubject) {
  if (type === "follow_up_1") {
    const body2 = `Hey ${leadName},

Bumping this in case my last email got buried. Would love to hear back when you get a chance.

Cheers,
Owais
Aussie Venture
hello@aussieventure.com`;
    return {
      subject: `Re: ${initialSubject}`,
      body: body2,
      html: textToHtml(body2)
    };
  }
  if (type === "follow_up_2") {
    const body2 = `Hey ${leadName},

Last message from me on this one. If you ever want to do a collab down the track, just email us at hello@aussieventure.com.

Cheers,
Owais
Aussie Venture`;
    return {
      subject: `Re: ${initialSubject}`,
      body: body2,
      html: textToHtml(body2)
    };
  }
  const body = `Hey ${leadName},

Last message from me on this one. If you ever want to do a collab down the track, just email us at hello@aussieventure.com.

Cheers,
Owais
Aussie Venture`;
  return {
    subject: `Re: ${initialSubject}`,
    body,
    html: textToHtml(body)
  };
}
__name(buildFollowUpEmail, "buildFollowUpEmail");
async function sendFollowUp(supabase, candidate, type) {
  const followUpNumber = type === "follow_up_1" ? 1 : type === "follow_up_2" ? 2 : 3;
  const { subject, body, html } = buildFollowUpEmail(type, candidate.lead.business_name, candidate.initialEmail.subject);
  const result = await sendEmail({
    to: candidate.lead.email,
    subject,
    html,
    text: body,
    leadId: candidate.lead.id
  });
  const { data: emailRow } = await supabase.from("emails").insert({
    lead_id: candidate.lead.id,
    type,
    subject,
    body_html: html,
    body_text: body,
    resend_id: result?.id ?? null,
    status: result ? "sent" : "failed",
    sent_at: result ? (/* @__PURE__ */ new Date()).toISOString() : null
  }).select().single();
  if (emailRow) {
    await supabase.from("follow_ups").insert({
      lead_id: candidate.lead.id,
      follow_up_number: followUpNumber,
      scheduled_at: (/* @__PURE__ */ new Date()).toISOString(),
      sent_at: result ? (/* @__PURE__ */ new Date()).toISOString() : null,
      email_id: emailRow.id,
      status: result ? "sent" : "cancelled"
    });
  }
  await supabase.from("activity_log").insert({
    event_type: `${type}_sent`,
    lead_id: candidate.lead.id,
    description: `Follow-up ${followUpNumber} sent to ${candidate.lead.business_name}`,
    metadata: { days_since: candidate.daysSince }
  });
  logger.info("followup", `Follow-up ${followUpNumber} sent: ${candidate.lead.business_name}`, {
    daysSince: candidate.daysSince
  });
  return !!result;
}
__name(sendFollowUp, "sendFollowUp");
async function runFollowUpAgent() {
  const supabase = createServiceClient();
  try {
    const { data: systemSetting } = await supabase.from("settings").select("value").eq("key", "system_active").single();
    if (systemSetting?.value !== "true") {
      logger.info("followup", "System paused - skipped");
      return;
    }
    const { data: settingsRows } = await supabase.from("settings").select("key, value").in("key", [
      "follow_up_1_days",
      "follow_up_2_days",
      "dead_lead_days",
      "daily_followup1_limit",
      "daily_followup2_limit",
      "daily_followup3_limit"
    ]);
    const settings = {};
    for (const row of settingsRows ?? []) {
      settings[row.key] = parseInt(row.value, 10);
    }
    const followUp1Days = settings["follow_up_1_days"] ?? 7;
    const followUp2Days = settings["follow_up_2_days"] ?? 14;
    const followUp3Days = settings["dead_lead_days"] ?? 21;
    const today = getAnalyticsDayRange();
    const limits = {
      follow_up_1: settings[FOLLOW_UP_LIMIT_KEYS.follow_up_1] ?? FOLLOW_UP_DEFAULT_LIMITS.follow_up_1,
      follow_up_2: settings[FOLLOW_UP_LIMIT_KEYS.follow_up_2] ?? FOLLOW_UP_DEFAULT_LIMITS.follow_up_2,
      follow_up_3: settings[FOLLOW_UP_LIMIT_KEYS.follow_up_3] ?? FOLLOW_UP_DEFAULT_LIMITS.follow_up_3
    };
    const sentBeforeRun = {
      follow_up_1: await sentTodayCount(supabase, "follow_up_1", today),
      follow_up_2: await sentTodayCount(supabase, "follow_up_2", today),
      follow_up_3: await sentTodayCount(supabase, "follow_up_3", today)
    };
    const remaining = {
      follow_up_1: Math.max(0, limits.follow_up_1 - sentBeforeRun.follow_up_1),
      follow_up_2: Math.max(0, limits.follow_up_2 - sentBeforeRun.follow_up_2),
      follow_up_3: Math.max(0, limits.follow_up_3 - sentBeforeRun.follow_up_3)
    };
    logger.info("followup", "[FOLLOWUP_ALLOCATION]", {
      fu1_allocation: remaining.follow_up_1,
      fu2_allocation: remaining.follow_up_2,
      fu3_allocation: remaining.follow_up_3,
      limits,
      sent_before_run: sentBeforeRun
    });
    const { data: contactedLeads } = await supabase.from("leads").select("*, emails(id, type, subject, sent_at)").eq("status", "contacted");
    if (!contactedLeads?.length) {
      logger.info("followup", "No contacted leads to follow up");
      logger.info("followup", "[FOLLOWUP_QUEUE]", { pending_follow_up_1: 0, pending_follow_up_2: 0, pending_follow_up_3: 0 });
      return;
    }
    const queues = {
      follow_up_1: [],
      follow_up_2: [],
      follow_up_3: []
    };
    let markedDead = 0;
    for (const lead of contactedLeads) {
      if (!lead.email) continue;
      const emailsList = lead.emails ?? [];
      const initialEmail = emailsList.find((email) => email.type === "initial_pitch" && email.sent_at);
      if (!initialEmail?.sent_at) continue;
      const daysSince = Math.floor((Date.now() - new Date(initialEmail.sent_at).getTime()) / 864e5);
      const hasFollowUp1 = emailsList.some((email) => email.type === "follow_up_1");
      const hasFollowUp2 = emailsList.some((email) => email.type === "follow_up_2");
      const followUp3Email = emailsList.find((email) => email.type === "follow_up_3" && email.sent_at);
      const hasFollowUp3 = !!followUp3Email;
      if (followUp3Email?.sent_at && followUp3Email.sent_at < today.start && daysSince >= followUp3Days) {
        await supabase.from("leads").update({ status: "dead" }).eq("id", lead.id);
        await supabase.from("activity_log").insert({
          event_type: "lead_marked_dead",
          lead_id: lead.id,
          description: `Lead marked as dead: ${lead.business_name} (${daysSince} days no reply)`,
          metadata: { days_since: daysSince }
        });
        logger.info("followup", `Marked dead: ${lead.business_name}`, { daysSince });
        markedDead++;
        continue;
      }
      const candidate = { lead, initialEmail, daysSince };
      if (daysSince >= followUp3Days && hasFollowUp1 && hasFollowUp2 && !hasFollowUp3) {
        queues.follow_up_3.push(candidate);
      } else if (daysSince >= followUp2Days && hasFollowUp1 && !hasFollowUp2) {
        queues.follow_up_2.push(candidate);
      } else if (daysSince >= followUp1Days && !hasFollowUp1) {
        queues.follow_up_1.push(candidate);
      }
    }
    logger.info("followup", "[FOLLOWUP_QUEUE]", {
      pending_follow_up_1: queues.follow_up_1.length,
      pending_follow_up_2: queues.follow_up_2.length,
      pending_follow_up_3: queues.follow_up_3.length,
      limits,
      sent_before_run: sentBeforeRun,
      remaining,
      today_range: today
    });
    const sent = {
      follow_up_1: 0,
      follow_up_2: 0,
      follow_up_3: 0
    };
    for (const type of ["follow_up_1", "follow_up_2", "follow_up_3"]) {
      const queue = queues[type].slice(0, remaining[type]);
      for (const candidate of queue) {
        const wasSent = await sendFollowUp(supabase, candidate, type);
        if (wasSent) sent[type]++;
      }
    }
    logger.info("followup", "[FOLLOWUP_SENT]", {
      sent_follow_up_1: sent.follow_up_1,
      sent_follow_up_2: sent.follow_up_2,
      sent_follow_up_3: sent.follow_up_3
    });
    await supabase.from("activity_log").insert({
      event_type: "followup_complete",
      description: `Follow-up agent done. FU1: ${sent.follow_up_1}, FU2: ${sent.follow_up_2}, FU3: ${sent.follow_up_3}, Dead: ${markedDead}`,
      metadata: {
        follow_up_1_sent: sent.follow_up_1,
        follow_up_2_sent: sent.follow_up_2,
        follow_up_3_sent: sent.follow_up_3,
        marked_dead: markedDead,
        limits,
        pending: {
          follow_up_1: queues.follow_up_1.length,
          follow_up_2: queues.follow_up_2.length,
          follow_up_3: queues.follow_up_3.length
        }
      }
    });
    logger.info("followup", "Done", {
      followUp1Sent: sent.follow_up_1,
      followUp2Sent: sent.follow_up_2,
      followUp3Sent: sent.follow_up_3,
      markedDead
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("followup", "Fatal error", { error: message, stack: error instanceof Error ? error.stack : null });
    await supabase.from("activity_log").insert({
      event_type: "agent_error",
      description: `Agent failed: ${message}`,
      metadata: {
        agent: "followup",
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    });
    throw error;
  }
}
__name(runFollowUpAgent, "runFollowUpAgent");

export {
  emailBodyToHtml,
  runFollowUpAgent
};
//# sourceMappingURL=chunk-O3DEJT6L.mjs.map
