// Supabase Edge Function: room-visit
// Logs an event from the data room (page opened, passphrase accepted, passphrase refused)
// with the visitor's IP, approximate location and device. Admin-only to read, via the dashboard.
// Secrets used: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (built in), ALLOWED_ORIGIN (optional).

import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const EVENTS = new Set(["open", "unlock", "fail", "download", "section"]);

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Approximate location from the IP. Done here so the visitor's browser never talks to a third party.
async function geo(ip: string) {
  if (!ip || ip === "unknown" || ip.startsWith("10.") || ip.startsWith("192.168.") || ip === "127.0.0.1") return {};
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { signal: ctl.signal, headers: { "User-Agent": "kiryat-yam-suf-room/1" } });
    clearTimeout(t);
    if (!r.ok) return {};
    const g = await r.json();
    if (g.error) return {};
    return { country: str(g.country_name, 80), region: str(g.region, 80), city: str(g.city, 80), org: str(g.org, 120) };
  } catch {
    return {};
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const event = str(body.event, 20);
  if (!EVENTS.has(event)) return json({ error: "bad_event" }, 400);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ua = req.headers.get("user-agent") ?? "";
  const g = await geo(ip);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await sb.from("room_visits").insert({
    event,
    detail: str(body.detail, 120) || null,
    visitor: str(body.visitor, 64) || null, // random id kept in the visitor's browser, groups one person's events
    ip,
    country: g.country ?? null,
    region: g.region ?? null,
    city: g.city ?? null,
    org: g.org ?? null,
    user_agent: ua.slice(0, 300),
    referrer: str(body.referrer, 300) || null,
    lang: str(body.lang, 20) || null,
    screen: str(body.screen, 20) || null,
  });
  if (error) { console.error(error); return json({ error: "db" }, 500); }
  return json({ ok: true });
});
