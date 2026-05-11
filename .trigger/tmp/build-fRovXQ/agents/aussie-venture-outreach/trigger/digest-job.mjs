import {
  createServiceClient,
  getDashboardMetrics,
  getLeadName,
  logAnalyticsMetrics,
  logger,
  sendEmail
} from "../../../chunk-4PKXMH3C.mjs";
import {
  schedules_exports
} from "../../../chunk-YMG6YHR2.mjs";
import "../../../chunk-KOWVEGTZ.mjs";
import {
  __name,
  init_esm
} from "../../../chunk-ZETKKQG6.mjs";

// trigger/digest-job.ts
init_esm();

// agents/tracker.ts
init_esm();
async function sendDailyDigest() {
  const supabase = createServiceClient();
  try {
    const { data: digestSetting } = await supabase.from("settings").select("value").eq("key", "digest_email").single();
    const digestEmail = digestSetting?.value ?? "hello@aussieventure.com";
    const { data: appUrlSetting } = await supabase.from("settings").select("value").eq("key", "app_url").single();
    const appUrl = appUrlSetting?.value ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const now = /* @__PURE__ */ new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 864e5).toISOString();
    const metrics = await getDashboardMetrics(supabase, now);
    logAnalyticsMetrics("[DIGEST_METRICS]", {
      range: metrics.todayEmailStats.range,
      totalEmails: metrics.todayEmailStats.totalSent,
      followups: metrics.followupStats.sentToday,
      replies: metrics.replyStats.repliesToday
    });
    const recentEmails = metrics.todayEmailStats.emails;
    const initialEmails = recentEmails.filter((email) => email.type === "initial_pitch");
    const followUpEmails = recentEmails.filter((email) => email.type !== "initial_pitch");
    const { data: newReplies } = await supabase.from("emails").select("id, lead_id, replied_at, leads(business_name)").not("replied_at", "is", null).gte("replied_at", metrics.todayEmailStats.range.start).lt("replied_at", metrics.todayEmailStats.range.end);
    const { data: dealsThisWeek } = await supabase.from("deals").select("lead_id, deal_value, leads(business_name)").gte("closed_at", oneWeekAgo);
    const totalDealValue = (dealsThisWeek ?? []).reduce((sum, deal) => sum + (deal.deal_value ?? 0), 0);
    const { data: agentErrors } = await supabase.from("activity_log").select("description, metadata, created_at").eq("event_type", "agent_error").gte("created_at", metrics.todayEmailStats.range.start).lt("created_at", metrics.todayEmailStats.range.end).order("created_at", { ascending: true });
    const date = now.toLocaleDateString("en-AU", {
      timeZone: metrics.todayEmailStats.range.timezone,
      day: "numeric",
      month: "long",
      year: "numeric"
    });
    const emailList = initialEmails.map((email) => `- ${getLeadName(email)}`).join("\n");
    const followUpList = followUpEmails.map((email) => `- ${getLeadName(email)} (${email.type.replace("_", " ")})`).join("\n");
    const repliesList = (newReplies ?? []).map((reply) => {
      const lead = reply.leads;
      const businessName = Array.isArray(lead) ? lead[0]?.business_name : lead?.business_name;
      return `- ${businessName ?? "Unknown"}`;
    }).join("\n");
    const dealsList = (dealsThisWeek ?? []).map((deal) => {
      const lead = deal.leads;
      return `- ${lead?.business_name ?? "Unknown"} ($${deal.deal_value})`;
    }).join("\n");
    const errorsList = (agentErrors ?? []).map((error) => {
      const meta = error.metadata;
      const agent = meta?.agent ?? "unknown";
      const errorMsg = meta?.error ?? error.description ?? "";
      const time = new Date(error.created_at).toLocaleTimeString("en-AU", {
        timeZone: metrics.todayEmailStats.range.timezone,
        hour: "2-digit",
        minute: "2-digit"
      });
      return `- ${agent} agent failed at ${time}: ${errorMsg.slice(0, 100)}`;
    }).join("\n");
    const body = `Morning Owais!

Here's what happened today:

TOTAL EMAILS SENT TODAY (${metrics.todayEmailStats.totalSent})

INITIAL EMAILS SENT (${initialEmails.length})
${emailList || "None"}

FOLLOW-UPS SENT (${followUpEmails.length})
${followUpList || "None"}

NEW REPLIES (${metrics.replyStats.repliesToday})
${repliesList || "None"}

DEALS CLOSED THIS WEEK (${(dealsThisWeek ?? []).length})
${dealsList || "None"}
Total this week: $${totalDealValue.toFixed(2)}

${(agentErrors ?? []).length > 0 ? `
PIPELINE ERRORS (${(agentErrors ?? []).length})
${errorsList}
` : ""}View Dashboard: ${appUrl}/dashboard`;
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f1117; color: #e2e8f0;">
<h2 style="color: #38bdf8;">Aussie Venture Outreach: Daily Summary</h2>
<p style="color: #94a3b8;">${date}</p>
<p>Morning Owais!</p>
<p>Here's what happened today:</p>

<h3 style="color: #38bdf8;">Total Emails Sent Today (${metrics.todayEmailStats.totalSent})</h3>

<h3 style="color: #38bdf8;">Initial Emails Sent (${initialEmails.length})</h3>
<p style="white-space: pre-line;">${emailList || "None"}</p>

<h3 style="color: #a78bfa;">Follow-ups Sent (${followUpEmails.length})</h3>
<p style="white-space: pre-line;">${followUpList || "None"}</p>

<h3 style="color: #4ade80;">New Replies (${metrics.replyStats.repliesToday})</h3>
<p style="white-space: pre-line;">${repliesList || "None"}</p>

<h3 style="color: #fbbf24;">Deals Closed This Week (${(dealsThisWeek ?? []).length})</h3>
<p style="white-space: pre-line;">${dealsList || "None"}</p>
<p><strong>Total this week: $${totalDealValue.toFixed(2)}</strong></p>

${(agentErrors ?? []).length > 0 ? `<h3 style="color: #f87171;">Pipeline Errors (${(agentErrors ?? []).length})</h3><p style="white-space: pre-line; color: #fca5a5;">${errorsList}</p>` : ""}
<p><a href="${appUrl}/dashboard" style="background: #38bdf8; color: #0f1117; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold;">View Dashboard</a></p>
</body>
</html>`;
    await sendEmail({
      to: digestEmail,
      subject: `Aussie Venture Outreach: Daily Summary ${date}`,
      html,
      text: body,
      leadId: "digest"
    });
    await supabase.from("activity_log").insert({
      event_type: "digest_sent",
      description: `Daily digest sent to ${digestEmail}`,
      metadata: {
        emails_sent: initialEmails.length,
        total_emails_sent: metrics.todayEmailStats.totalSent,
        follow_ups_sent: metrics.followupStats.sentToday,
        new_replies: metrics.replyStats.repliesToday,
        deals_this_week: (dealsThisWeek ?? []).length
      }
    });
    logger.info("tracker", "Daily digest sent", { to: digestEmail });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("tracker", "Fatal error in sendDailyDigest", {
      error: message,
      stack: error instanceof Error ? error.stack : null
    });
    await supabase.from("activity_log").insert({
      event_type: "agent_error",
      description: `Agent failed: ${message}`,
      metadata: {
        agent: "tracker",
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    });
    throw error;
  }
}
__name(sendDailyDigest, "sendDailyDigest");

// trigger/digest-job.ts
var digestJob = schedules_exports.task({
  id: "digest-job",
  cron: {
    pattern: "30 10 * * *",
    timezone: "Australia/Sydney"
  },
  maxDuration: 300,
  run: /* @__PURE__ */ __name(async () => {
    console.log("Sending daily digest...");
    await sendDailyDigest();
    console.log("Daily digest sent");
  }, "run")
});
export {
  digestJob
};
//# sourceMappingURL=digest-job.mjs.map
