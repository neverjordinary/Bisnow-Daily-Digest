import { CronJob } from 'cron';

// ── Configuration ──────────────────────────────────────────────────
const JORDAN_EMAIL = "jordan.hinsch@bisnow.com";
const INTERNAL_DOMAINS = ["bisnow.com", "biscred.com", "selectleaders.com"];
const BISNOW_ORANGE = "#F37021";

const MCP_SERVERS = {
  gcal: { type: "url", url: "https://gcal.mcp.claude.com/mcp", name: "google-calendar" },
  gmail: { type: "url", url: "https://gmail.mcp.claude.com/mcp", name: "gmail" },
  zoominfo: { type: "url", url: "https://mcp.zoominfo.com/mcp", name: "zoominfo" },
};

// Florida events calendar (upcoming only — update quarterly)
const FLORIDA_EVENTS = [
  { date: "2026-03-31", name: "South Florida Architecture, Design & Interiors", format: "Morning", panels: 3, venue: "Hyatt Regency" },
  { date: "2026-04-23", name: "Future of Little River & Little Haiti", format: "Morning", panels: 2, venue: "Hagerty Garage & Social" },
  { date: "2026-04-28", name: "Condoverse (Condo Sales & Development)", format: "Full Day", panels: 6, venue: "Miami Airport Conv Ctr" },
  { date: "2026-05-14", name: "Tampa Bay State of the Market", format: "Morning", panels: 3, venue: "The Motor Enclave" },
  { date: "2026-05-21", name: "South Florida Affordable Housing Summit", format: "Morning", panels: 2, venue: "The Gale" },
  { date: "2026-05-28", name: "Broward County State of the Market", format: "Morning", panels: 4, venue: "Seminole Hard Rock Hotel" },
  { date: "2026-06-11", name: "South Florida Office Summit", format: "Morning", panels: 2, venue: "TBD" },
  { date: "2026-06-25", name: "Orlando State of the Market", format: "Morning", panels: 3, venue: "Orlando" },
  { date: "2026-06-30", name: "Florida & Caribbean Hospitality Summit", format: "Morning", panels: 3, venue: "Miami" },
  { date: "2026-07-16", name: "South Florida Construction & Development", format: "Morning", panels: 3, venue: "Miami" },
  { date: "2026-07-28", name: "Boca Raton State of the Market", format: "Morning", panels: 2, venue: "Boca Raton" },
  { date: "2026-08-04", name: "South Florida Opportunity Zones", format: "Morning", panels: 1, venue: "Miami" },
  { date: "2026-09-23", name: "Miami State of The Market", format: "Full Day", panels: 6, venue: "Jungle Island" },
  { date: "2026-10-08", name: "Ultra-Luxury Home Summit", format: "Morning", panels: 3, venue: "Miami" },
  { date: "2026-10-13", name: "Florida Industrial & Manufacturing", format: "Morning", panels: 2, venue: "Palm Beach County" },
  { date: "2026-10-20", name: "Florida Build-To-Rent", format: "Morning", panels: 2, venue: "Tampa/St Pete" },
  { date: "2026-11-17", name: "South Florida Multifamily Summit", format: "Morning", panels: 4, venue: "TBD" },
  { date: "2026-12-01", name: "Palm Beach State of the Market", format: "Full Day", panels: 6, venue: "Palm Beach County" },
];

// ── Anthropic API Helper ───────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, mcpServers = [], useWebSearch = false) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable is required");

  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (mcpServers.length > 0) body.mcp_servers = mcpServers;
  if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const texts = (data.content || []).filter(b => b.type === "text").map(b => b.text);
  const toolResults = (data.content || []).filter(b => b.type === "mcp_tool_result").map(b => b.content?.[0]?.text || "");
  return { texts, toolResults, raw: data };
}

function extractJson(text) {
  try {
    return JSON.parse(text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());
  } catch {
    const match = text.match(/[\[{][\s\S]*[\]}]/);
    if (match) try { return JSON.parse(match[0]); } catch { /* fall through */ }
    return null;
  }
}

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
}

function scoreColor(score) {
  if (score >= 70) return "#22C55E";
  if (score >= 40) return "#EAB308";
  return "#EF4444";
}

function getUpcomingEvents(n = 5) {
  const now = new Date();
  return FLORIDA_EVENTS.filter(e => new Date(e.date) > now)
    .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, n);
}

// ── Step 1: Fetch Calendar ─────────────────────────────────────────
async function fetchCalendar() {
  console.log("Fetching calendar...");
  const res = await callClaude(
    `You are a calendar assistant. Fetch today's events for jordan.hinsch@bisnow.com. Return ONLY a valid JSON array of events that have at least one attendee whose email does NOT end in @bisnow.com, @biscred.com, or @selectleaders.com. Structure: [{"title":"","start_time":"9:00 AM","end_time":"","location":"","description":"","external_attendees":[{"email":"","name":""}]}]. If no external meetings, return []. JSON only, no markdown.`,
    "Get all events for today, filter to external attendees only. Return JSON.",
    [MCP_SERVERS.gcal]
  );

  const allText = [...res.texts, ...res.toolResults].join("\n");
  let events = extractJson(allText);
  if (!Array.isArray(events)) events = events?.events || [];

  return events
    .map(e => ({
      ...e,
      external_attendees: (e.external_attendees || []).filter(a => {
        const domain = (a.email || "").split("@")[1]?.toLowerCase();
        return domain && !INTERNAL_DOMAINS.includes(domain);
      }),
    }))
    .filter(e => e.external_attendees.length > 0);
}

// ── Step 2: Research Meetings ──────────────────────────────────────
async function researchMeeting(mtg) {
  const contactList = mtg.external_attendees.map(a => `${a.name || "Unknown"} <${a.email}>`).join(", ");
  const upcomingStr = getUpcomingEvents(15).map(e => `${e.name} (${e.date}, ${e.format}, ${e.venue})`).join(" | ");

  console.log(`  Researching: ${mtg.title}...`);
  const res = await callClaude(
    `You are a sales intelligence researcher for Bisnow, a CRE media company. Jordan Hinsch is Head of Sales for Florida.

UPCOMING FL EVENTS: ${upcomingStr}

PRODUCTS: Presenting Sponsor $22,500 | Whole Panel Buyout $17,500 | Panelist $7,350 | Exhibitor Booth $2,350 | SoFla Brief Takeover $2,250 / Lead Ad $1,500 | Dedicated Email $6,500 | Custom Article $5,750

TARGET AUDIENCE: GC->developers,owners | Developer->LP investors,equity | Lender->developers,borrowers | Brokerage->investors,developers | Architecture->developers,owners | PropTech->owners,operators | Property Mgmt->owners,investors

Return ONLY valid JSON: {"contacts":[{"name":"","title":"","company":"","linkedin_url":"","email":""}],"company":{"name":"","description":"","hq":"","cre_relevance":"","florida_presence":""},"sponsorship_intel":{"past_cre_sponsorships":[{"event":"","url":""}],"advertising_evidence":[],"past_bisnow_sponsor":false},"recent_news":[{"headline":"","summary":"","url":"","date":"","mapped_bisnow_event":null,"mapped_event_date":null}],"match_score":0,"match_reasoning":"","best_fit_events":[{"event_name":"","date":"","venue":"","why":""}],"recommended_products":[{"product":"","price":"","rationale":""}],"national_opportunity":null,"target_audience":{"primary":[],"secondary":[],"pitch_rationale":""},"icebreaker":""}`,
    `Research: Meeting "${mtg.title}" at ${mtg.start_time}. Contacts: ${contactList}. Find LinkedIn, company overview, sponsorship history, recent news mapped to Bisnow events, match score, target audience, recommendations, icebreaker.`,
    [MCP_SERVERS.zoominfo],
    true
  );

  const allText = [...res.texts, ...res.toolResults].join("\n");
  return extractJson(allText);
}

// ── Step 3: Build HTML Email ───────────────────────────────────────
function buildEmailHtml(meetings, researchData) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });
  const nextEvent = getUpcomingEvents(1)[0];
  const totalPipeline = Object.values(researchData).reduce((sum, r) =>
    sum + (r?.recommended_products || []).reduce((s, p) => s + (parseFloat((p.price || "").replace(/[^0-9.]/g, "")) || 0), 0), 0);
  const topScore = Math.max(0, ...Object.values(researchData).map(r => r?.match_score || 0));

  let html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0B0F1A;color:#F8FAFC;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:0;">

<!-- Header -->
<div style="background:linear-gradient(135deg,#0B0F1A,#111827);padding:24px;border-bottom:2px solid ${BISNOW_ORANGE};">
  <div style="display:inline-block;background:${BISNOW_ORANGE};color:white;font-weight:800;font-size:14px;padding:4px 10px;border-radius:4px;letter-spacing:1px;">BISNOW</div>
  <span style="color:white;font-size:20px;font-weight:800;margin-left:10px;">Daily Sales Digest</span>
  <div style="color:#94A3B8;font-size:13px;margin-top:6px;">${today} &bull; Jordan Hinsch</div>
</div>

<!-- Summary -->
<div style="background:#111827;padding:16px 24px;border-bottom:1px solid #1E293B;">
  <table cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="padding-right:32px;">
      <div style="color:white;font-size:28px;font-weight:800;">${meetings.length}</div>
      <div style="color:#94A3B8;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">External Meetings</div>
    </td>
    <td style="padding-right:32px;">
      <div style="color:${scoreColor(topScore)};font-size:28px;font-weight:800;">${topScore}</div>
      <div style="color:#94A3B8;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">Top Score</div>
    </td>
    <td>
      <div style="color:${BISNOW_ORANGE};font-size:28px;font-weight:800;">$${totalPipeline.toLocaleString()}</div>
      <div style="color:#94A3B8;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">Pipeline</div>
    </td>
  </tr></table>
</div>`;

  // Next event banner
  if (nextEvent) {
    html += `
<div style="background:#111827;padding:12px 24px;border-bottom:1px solid #1E293B;">
  <div style="color:${BISNOW_ORANGE};font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">NEXT EVENT — ${daysUntil(nextEvent.date)} DAYS AWAY</div>
  <div style="color:white;font-size:15px;font-weight:700;margin-top:2px;">${nextEvent.name}</div>
  <div style="color:#94A3B8;font-size:12px;">${nextEvent.venue} &bull; ${nextEvent.format} &bull; ${nextEvent.panels} panels</div>
</div>`;
  }

  // Meeting cards
  meetings.forEach((mtg, i) => {
    const r = researchData[i] || {};
    const company = r.company || {};
    const contacts = r.contacts || [];
    const news = r.recent_news || [];
    const intel = r.sponsorship_intel || {};
    const events = r.best_fit_events || [];
    const products = r.recommended_products || [];
    const audience = r.target_audience || {};
    const score = r.match_score || 0;
    const sColor = scoreColor(score);
    const pitchTotal = products.reduce((s, p) => s + (parseFloat((p.price || "").replace(/[^0-9.]/g, "")) || 0), 0);

    html += `
<!-- Meeting ${i + 1} -->
<div style="background:#111827;margin:16px;border-radius:12px;border:1px solid #1E293B;overflow:hidden;">
  <!-- Header -->
  <div style="padding:16px 20px;border-left:4px solid ${sColor};">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td>
        <div style="color:${BISNOW_ORANGE};font-size:13px;font-weight:600;font-family:monospace;">${mtg.start_time || "TBD"}</div>
        <div style="color:white;font-size:20px;font-weight:800;margin-top:4px;">${company.name || "Researching..."}</div>
        <div style="color:#94A3B8;font-size:13px;margin-top:4px;line-height:1.4;">${company.description || ""}</div>
      </td>
      <td style="text-align:right;vertical-align:top;width:70px;">
        <div style="display:inline-block;width:56px;height:56px;border-radius:50%;border:3px solid ${sColor};text-align:center;line-height:50px;color:${sColor};font-size:18px;font-weight:800;font-family:monospace;">${score}</div>
      </td>
    </tr></table>
  </div>

  <!-- Icebreaker -->
  ${r.icebreaker ? `
  <div style="margin:0 20px 12px;padding:12px 16px;background:#1a2332;border-left:3px solid ${BISNOW_ORANGE};border-radius:0 8px 8px 0;">
    <div style="color:${BISNOW_ORANGE};font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">ICEBREAKER</div>
    <div style="color:#E2E8F0;font-size:14px;line-height:1.5;font-style:italic;">"${r.icebreaker}"</div>
  </div>` : ""}

  <div style="padding:0 20px 20px;">

  <!-- Contacts -->
  ${contacts.length > 0 ? `
  <div style="margin-bottom:16px;">
    <div style="color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">CONTACTS</div>
    ${contacts.map(c => `
    <div style="margin-bottom:6px;">
      <span style="color:white;font-size:14px;font-weight:600;">${c.name || c.email}</span>
      <span style="color:#94A3B8;font-size:12px;"> &mdash; ${c.title || ""}</span>
      ${c.linkedin_url ? `<a href="${c.linkedin_url}" style="color:#0A66C2;font-size:11px;text-decoration:none;margin-left:8px;">LinkedIn &#8599;</a>` : ""}
    </div>`).join("")}
  </div>` : ""}

  <!-- Who They Want to Meet -->
  ${audience.primary ? `
  <div style="margin-bottom:16px;background:#0f1923;border-radius:8px;padding:12px 14px;border:1px solid #1E293B;">
    <div style="color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">WHO THEY WANT TO MEET</div>
    <div style="color:white;font-size:13px;margin-bottom:4px;"><strong>Primary:</strong> ${Array.isArray(audience.primary) ? audience.primary.join(", ") : audience.primary}</div>
    ${audience.secondary ? `<div style="color:#94A3B8;font-size:12px;margin-bottom:4px;"><strong>Secondary:</strong> ${Array.isArray(audience.secondary) ? audience.secondary.join(", ") : audience.secondary}</div>` : ""}
    ${audience.pitch_rationale ? `<div style="color:${BISNOW_ORANGE};font-size:12px;font-style:italic;">${audience.pitch_rationale}</div>` : ""}
  </div>` : ""}

  <!-- News to Event Mapping -->
  ${news.length > 0 ? `
  <div style="margin-bottom:16px;">
    <div style="color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">NEWS &rarr; EVENT MAPPING</div>
    ${news.map(n => `
    <div style="margin-bottom:8px;padding-left:12px;border-left:2px solid #1E293B;">
      <div style="color:white;font-size:13px;">${n.headline}</div>
      <div style="color:#64748B;font-size:11px;">${n.date} ${n.url ? `<a href="${n.url}" style="color:#64748B;">&#8599;</a>` : ""}</div>
      ${n.mapped_bisnow_event ? `<div style="color:${BISNOW_ORANGE};font-size:12px;margin-top:2px;">&rarr; &#127919; ${n.mapped_bisnow_event}${n.mapped_event_date ? ` (${n.mapped_event_date})` : ""}</div>` : ""}
    </div>`).join("")}
  </div>` : ""}

  <!-- Sponsorship Intel -->
  ${(intel.past_cre_sponsorships?.length > 0 || intel.advertising_evidence?.length > 0) ? `
  <div style="margin-bottom:16px;">
    <div style="color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">SPONSORSHIP &amp; AD INTEL</div>
    ${(intel.past_cre_sponsorships || []).map(s => `<div style="color:#CBD5E1;font-size:13px;margin-bottom:4px;">&bull; ${s.event} ${s.url ? `<a href="${s.url}" style="color:#64748B;font-size:11px;">&#8599;</a>` : ""}</div>`).join("")}
    ${(intel.advertising_evidence || []).map(a => `<div style="color:#CBD5E1;font-size:13px;margin-bottom:4px;">&bull; ${a}</div>`).join("")}
    ${intel.past_bisnow_sponsor ? `<div style="color:#22C55E;font-size:12px;font-weight:600;margin-top:4px;">&#10003; Past Bisnow sponsor</div>` : ""}
  </div>` : ""}

  <!-- Recommended Events -->
  ${events.length > 0 ? `
  <div style="margin-bottom:16px;">
    <div style="color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">BEST-FIT EVENTS TO SPONSOR</div>
    ${events.map((e, j) => `
    <div style="margin-bottom:8px;padding:8px 12px;background:#0f1923;border-radius:6px;border:1px solid #1E293B;">
      <span style="color:${BISNOW_ORANGE};font-size:16px;font-weight:800;margin-right:8px;">${j + 1}</span>
      <span style="color:white;font-size:13px;font-weight:600;">${e.event_name}</span>
      <div style="color:#94A3B8;font-size:11px;margin-top:2px;padding-left:24px;">${e.date} &bull; ${e.venue}${e.why ? ` &mdash; ${e.why}` : ""}</div>
    </div>`).join("")}
  </div>` : ""}

  <!-- Recommended Pitch -->
  ${products.length > 0 ? `
  <div style="margin-bottom:16px;">
    <div style="color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">RECOMMENDED PITCH</div>
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      ${products.map(p => `<tr><td style="padding:6px 0;color:white;font-size:13px;border-bottom:1px solid #1E293B;">${p.product}</td><td style="padding:6px 0;color:${BISNOW_ORANGE};font-size:13px;font-weight:700;font-family:monospace;text-align:right;border-bottom:1px solid #1E293B;">${p.price}</td></tr>`).join("")}
      <tr><td style="padding:10px 0;color:white;font-size:14px;font-weight:700;">Total Pipeline</td><td style="padding:10px 0;color:${BISNOW_ORANGE};font-size:18px;font-weight:800;font-family:monospace;text-align:right;">$${pitchTotal.toLocaleString()}</td></tr>
    </table>
  </div>` : ""}

  <!-- National Opportunity -->
  ${r.national_opportunity ? `
  <div style="padding:10px 14px;background:#0c1a2e;border-radius:8px;border:1px solid #1e3a5f;">
    <div style="color:#3B82F6;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">&#127760; NATIONAL OPPORTUNITY</div>
    <div style="color:#CBD5E1;font-size:13px;line-height:1.4;">${r.national_opportunity}</div>
  </div>` : ""}

  </div>
</div>`;
  });

  // Upcoming events footer
  const upcoming = getUpcomingEvents(5);
  html += `
<div style="background:#111827;margin:16px;border-radius:12px;border:1px solid #1E293B;padding:16px 20px;">
  <div style="color:#94A3B8;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">UPCOMING FLORIDA EVENTS</div>
  ${upcoming.map(e => `
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-bottom:1px solid #1E293B;">
    <tr>
      <td style="padding:8px 0;">
        <div style="color:white;font-size:13px;font-weight:600;">${e.name}</div>
        <div style="color:#94A3B8;font-size:11px;">${e.venue}${e.format === "Full Day" ? ` &mdash; <span style="color:${BISNOW_ORANGE};font-weight:600;">FULL DAY</span>` : ""}</div>
      </td>
      <td style="padding:8px 0;text-align:right;vertical-align:top;width:50px;">
        <div style="color:${BISNOW_ORANGE};font-size:13px;font-weight:700;font-family:monospace;white-space:nowrap;">${daysUntil(e.date)}d</div>
      </td>
    </tr>
  </table>`).join("")}
</div>

<!-- Footer -->
<div style="padding:20px 24px;text-align:center;">
  <div style="color:#475569;font-size:11px;">Generated by Bisnow Sales Intelligence &bull; ${today}</div>
  <div style="color:#334155;font-size:10px;margin-top:4px;">Reply to this email with feedback or &quot;stop&quot; to unsubscribe</div>
</div>

</div></body></html>`;

  return html;
}

// ── Step 4: Send via Gmail ─────────────────────────────────────────
async function sendEmail(subject, htmlBody) {
  console.log("Sending digest email...");
  const res = await callClaude(
    `You are an email assistant. Send an email using Gmail. The email should be sent as HTML. Do not modify the content — send it exactly as provided.`,
    `Send this email:
To: ${JORDAN_EMAIL}
Subject: ${subject}
Content-Type: text/html

${htmlBody}`,
    [MCP_SERVERS.gmail]
  );
  console.log("Email sent!");
  return res;
}

// ── Empty Day Email ────────────────────────────────────────────────
function buildEmptyEmailHtml(today) {
  const upcoming = getUpcomingEvents(5);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0B0F1A;color:#F8FAFC;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:680px;margin:0 auto;">
  <div style="background:#111827;padding:24px;border-bottom:2px solid ${BISNOW_ORANGE};">
    <div style="display:inline-block;background:${BISNOW_ORANGE};color:white;font-weight:800;font-size:14px;padding:4px 10px;border-radius:4px;">BISNOW</div>
    <span style="color:white;font-size:20px;font-weight:800;margin-left:10px;">Daily Sales Digest</span>
    <div style="color:#94A3B8;font-size:13px;margin-top:6px;">${today}</div>
  </div>
  <div style="padding:40px 24px;text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">&#128237;</div>
    <div style="color:white;font-size:20px;font-weight:700;margin-bottom:8px;">No external meetings today</div>
    <div style="color:#94A3B8;font-size:14px;margin-bottom:32px;">Good day to prospect &mdash; here are events that need sponsors:</div>
    ${upcoming.map(e => `<div style="text-align:left;padding:10px 0;border-bottom:1px solid #1E293B;"><span style="color:white;font-size:14px;font-weight:600;">${e.name}</span><span style="color:${BISNOW_ORANGE};font-size:12px;font-weight:600;float:right;">${daysUntil(e.date)}d away</span><div style="color:#94A3B8;font-size:12px;">${e.venue}</div></div>`).join("")}
  </div>
</div></body></html>`;
}

// ── Main Digest Function ──────────────────────────────────────────
async function runDigest() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  console.log(`\n${"=".repeat(50)}`);
  console.log(`BISNOW DAILY DIGEST — ${today}`);
  console.log(`${"=".repeat(50)}\n`);

  try {
    // Step 1: Calendar
    const meetings = await fetchCalendar();
    console.log(`Found ${meetings.length} external meeting(s)\n`);

    if (meetings.length === 0) {
      const emptyHtml = buildEmptyEmailHtml(today);
      await sendEmail(`Daily Digest — ${today} — No External Meetings`, emptyHtml);
      return;
    }

    // Step 2: Research each meeting
    const researchData = {};
    for (let i = 0; i < meetings.length; i++) {
      researchData[i] = await researchMeeting(meetings[i]);
      // Small delay to avoid rate limits
      if (i < meetings.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    // Step 3: Build email
    const topScore = Math.max(0, ...Object.values(researchData).map(r => r?.match_score || 0));
    const htmlBody = buildEmailHtml(meetings, researchData);
    const subject = `Daily Digest — ${today} — ${meetings.length} Meeting${meetings.length > 1 ? "s" : ""} | Top: ${topScore}`;

    // Step 4: Send
    await sendEmail(subject, htmlBody);

    console.log(`\nDigest complete! ${meetings.length} meetings processed.\n`);

  } catch (err) {
    console.error("Digest failed:", err);
    // Send error notification
    try {
      await sendEmail(
        `Daily Digest Error — ${today}`,
        `<html><body style="margin:0;padding:20px;background:#0B0F1A;color:#F8FAFC;font-family:Arial,sans-serif;"><p style="color:#EF4444;font-weight:bold;">The daily digest failed to generate.</p><p style="color:#94A3B8;">Error: ${err.message}</p><p style="color:#64748B;">Check the logs and retry.</p></body></html>`
      );
    } catch { /* silent */ }
  }
}

// ── Scheduler ──────────────────────────────────────────────────────
// Run Monday-Friday at 8:00 AM ET
const job = new CronJob(
  '0 8 * * 1-5',        // 8:00 AM, Mon-Fri
  runDigest,             // Function to run
  null,                  // onComplete
  true,                  // start immediately
  'America/New_York'     // Timezone
);

console.log("Bisnow Daily Digest scheduler started");
console.log("  Schedule: Monday-Friday at 8:00 AM ET");
console.log("  Recipient: jordan.hinsch@bisnow.com");
console.log("");

// Run immediately if --test flag is passed
if (process.argv.includes("--test")) {
  runDigest();
}
