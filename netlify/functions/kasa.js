const hits = {}; // best-effort rate limit (resets when function restarts)

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function reps() {
  const out = {};
  (process.env.REP_PINS || "").split(",").forEach((p) => {
    const [n, pin] = p.split(":").map((s) => s && s.trim());
    if (n && pin) out[n] = pin;
  });
  return out;
}

// 024 123 4567 -> 233241234567
const toIntl = (n) => {
  const d = String(n).replace(/\D/g, "");
  return d.startsWith("233") ? d : "233" + d.replace(/^0/, "");
};
const valid = (n) => /^233\d{9}$/.test(toIntl(n));

// Supabase REST helper (server key never reaches the browser)
async function db(path, opts = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error((data && data.message) || "Database error");
  return data;
}

const groupNames = async () => {
  const rows = await db("students?select=group_name,opted_out&limit=100000");
  const g = {};
  rows.forEach((r) => {
    g[r.group_name] = g[r.group_name] || { name: r.group_name, total: 0, active: 0 };
    g[r.group_name].total++;
    if (!r.opted_out) g[r.group_name].active++;
  });
  return Object.values(g).sort((a, b) => a.name.localeCompare(b.name));
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad request" }); }

  const { name, pin, action, group, message } = b;
  const list = reps();
  if (!name || list[name] !== pin) return json(401, { error: "Wrong name or PIN" });

  try {
    if (action === "login") return json(200, { groups: await groupNames() });

    if (action === "history") {
      return json(200, { sends: await db("sends?select=rep,group_name,message,recipients,created_at&order=created_at.desc&limit=20") });
    }

    if (action === "add") {
      const g = (group || "").trim();
      if (!g) return json(400, { error: "Enter a group name" });
      const nums = [...new Set(String(b.numbers || "").split(/[\s,;]+/).filter(Boolean))];
      const good = nums.filter(valid).map(toIntl);
      if (!good.length) return json(400, { error: "No valid numbers found" });
      await db("students?on_conflict=phone,group_name", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify(good.map((phone) => ({ phone, group_name: g }))),
      });
      return json(200, { added: good.length, bad: nums.length - good.length, groups: await groupNames() });
    }

    if (action === "optout" || action === "optin") {
      if (!valid(b.number)) return json(400, { error: "Enter a valid number" });
      const rows = await db(`students?phone=eq.${toIntl(b.number)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ opted_out: action === "optout" }),
      });
      if (!rows.length) return json(404, { error: "Number not found in any group" });
      return json(200, { ok: true });
    }

    // send
    const text = (message || "").trim();
    if (!group) return json(400, { error: "Pick a group" });
    if (!text || text.length > 306) return json(400, { error: "Message must be 1-306 characters" });

    const now = Date.now();
    hits[name] = (hits[name] || []).filter((t) => now - t < 3600000);
    if (hits[name].length >= 10) return json(429, { error: "Limit: 10 sends per hour" });

    // optional schedule: "2026-11-21T14:30", read as Ghana time (UTC, no daylight saving)
    let when = null;
    if (b.when) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(b.when);
      if (!m) return json(400, { error: "Invalid date or time" });
      const [, y, mo, d, h, mi] = m.map(Number);
      if (Date.UTC(y, mo - 1, d, h, mi) < now + 5 * 60000) return json(400, { error: "Pick a time at least 5 minutes from now" });
      when = `${m[1]}-${m[2]}-${m[3]} ${String(h % 12 || 12).padStart(2, "0")}:${m[5]} ${h < 12 ? "AM" : "PM"}`;
    }

    const all = await db(`students?group_name=eq.${encodeURIComponent(group)}&select=phone,opted_out`);
    if (!all.length) return json(400, { error: "Group not found" });
    const recipients = all.filter((s) => !s.opted_out).map((s) => s.phone);
    if (!recipients.length) return json(400, { error: "Everyone in this group has opted out" });

    const res = await fetch("https://sms.arkesel.com/api/v2/sms/send", {
      method: "POST",
      headers: { "api-key": process.env.ARKESEL_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: process.env.ARKESEL_SENDER || "KASA",
        message: `${text}\n- ${name}. To opt out, tell your rep.`,
        recipients,
        ...(when ? { scheduled_date: when } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === "error") {
      return json(502, { error: data.message || "Arkesel rejected the send" });
    }
    hits[name].push(now);
    await db("sends", {
      method: "POST",
      body: JSON.stringify({ rep: name, group_name: group, message: (when ? `[scheduled ${when}] ` : "") + text, recipients: recipients.length }),
    }).catch(() => {}); // a logging failure must not hide a successful send
    return json(200, { ok: true, when, sent: recipients.length, skipped: all.length - recipients.length });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
