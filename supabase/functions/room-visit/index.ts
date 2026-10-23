// Supabase Edge Function: room-visit
// Logs an event from the data room (page opened, passphrase accepted, passphrase refused)
// with the visitor's IP, approximate location and device. Admin-only to read, via the dashboard.
// Secrets used: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (built in), ALLOWED_ORIGIN (optional).
// Limits: a soft per-address and per-visitor limit (per running instance) and a site-wide cap of
// 3000 events per UTC day, counted by bump_usage() from hardening.sql.

import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const EVENTS = new Set(["open", "unlock", "fail", "download", "section"]);
const DAILY_CAP = 3000;

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---------- client address ----------
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function normIpv6(s: string): string | null {
  if (!s.includes(":") || !/^[0-9a-fA-F:.]{2,45}$/.test(s)) return null;
  try { return new URL(`http://[${s}]/`).hostname.slice(1, -1); } catch { return null; }
}
function canonIp(s: string): string | null {
  const v = s.trim();
  if (IPV4.test(v)) return v;
  return normIpv6(v);
}
// cf-connecting-ip is set by the edge proxy when present. Otherwise use the first x-forwarded-for entry, which on
// Supabase is the real client (later entries can be shared proxy hops). It can be spoofed, which the daily cap bounds.
function clientIp(req: Request): string {
  const cf = canonIp(req.headers.get("cf-connecting-ip") ?? "");
  if (cf) return cf;
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",").map(canonIp).filter((v): v is string => !!v);
  if (xff.length) return xff[0];
  return canonIp(req.headers.get("x-real-ip") ?? "") ?? "";
}
// IPv6 users get a whole /64, so limit by that rather than by single address.
function rateKey(ip: string): string {
  if (!ip.includes(":")) return ip || "unknown";
  let parts: string[];
  if (ip.includes("::")) {
    const [a, b] = ip.split("::");
    const head = a ? a.split(":") : [], tail = b ? b.split(":") : [];
    parts = [...head, ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  } else parts = ip.split(":");
  return parts.slice(0, 4).join(":") + "::/64";
}
// Only real public addresses are worth a lookup (and the free ipapi.co quota).
function isPublicIp(ip: string): boolean {
  if (IPV4.test(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  const v6 = normIpv6(ip);
  if (!v6) return false;
  const parts = v6.split(":");
  if (!parts[0]) return false; // ::, ::1, IPv4-mapped and similar
  const first = parseInt(parts[0], 16);
  if (first < 0x2000 || first > 0x3fff) return false; // only global unicast 2000::/3
  if (first === 0x2001 && parts[1] === "db8") return false; // documentation range
  return true;
}

// ---------- soft limits (per running instance) ----------
const WINDOW = 10 * 60 * 1000, MAX_KEYS = 5000;
function makeLimiter(max: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW);
    list.push(now);
    if (list.length > max + 1) list.splice(0, list.length - (max + 1));
    hits.delete(key);
    hits.set(key, list); // Map keeps insertion order, so the least recently seen keys come first
    for (const k of hits.keys()) {
      if (hits.size <= MAX_KEYS) break;
      hits.delete(k);
    }
    return list.length > max;
  };
}
const ipLimited = makeLimiter(120); // events per 10 minutes per address
const visitorLimited = makeLimiter(60); // events per 10 minutes per visitor id

// ---------- location ----------
type Geo = { country?: string; region?: string; city?: string; org?: string };
const geoCache = new Map<string, { at: number; g: Geo }>();
const GEO_TTL = 6 * 60 * 60 * 1000;

// Approximate location from the IP. Done here so the visitor's browser never talks to a third party.
async function geo(ip: string): Promise<Geo> {
  if (!isPublicIp(ip)) return {};
  const hit = geoCache.get(ip);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.g;
  let g: Geo = {};
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: AbortSignal.timeout(2500),
      headers: { "User-Agent": "kiryat-yam-suf-room/1" },
    });
    if (r.ok) {
      const d = await r.json();
      if (d && !d.error) {
        g = { country: str(d.country_name, 80), region: str(d.region, 80), city: str(d.city, 80), org: str(d.org, 120) };
      }
    }
  } catch {
    return {};
  }
  geoCache.set(ip, { at: Date.now(), g });
  for (const k of geoCache.keys()) {
    if (geoCache.size <= 1000) break;
    geoCache.delete(k);
  }
  return g;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);

  const event = str(body.event, 20);
  if (!EVENTS.has(event)) return json({ error: "bad_event" }, 400);

  const ip = clientIp(req);
  // Random id kept in the visitor's browser (a UUID), groups one person's events.
  const visitorRaw = str(body.visitor, 64);
  const visitor = /^[A-Za-z0-9-]{8,64}$/.test(visitorRaw) ? visitorRaw : null;

  if (ipLimited(rateKey(ip))) return json({ error: "rate_limited" }, 429);
  if (visitor && visitorLimited(visitor)) return json({ error: "rate_limited" }, 429);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Site-wide daily cap. Fails open: a counter problem just means the event is logged anyway.
  try {
    const { data: within, error: capErr } = await sb.rpc("bump_usage", { p_bucket: "room-visit", p_cap: DAILY_CAP });
    if (capErr) console.error("bump_usage failed, logging the event anyway", capErr);
    else if (within !== true) return json({ error: "daily_cap" }, 429);
  } catch (e) {
    console.error("bump_usage failed, logging the event anyway", e);
  }

  const ua = req.headers.get("user-agent") ?? "";
  const g = await geo(ip);

  const { error } = await sb.from("room_visits").insert({
    event,
    detail: str(body.detail, 120) || null,
    visitor,
    ip: ip || null,
    country: g.country || null,
    region: g.region || null,
    city: g.city || null,
    org: g.org || null,
    user_agent: ua.slice(0, 300),
    referrer: str(body.referrer, 300) || null,
    lang: str(body.lang, 20) || null,
    screen: str(body.screen, 20) || null,
  });
  if (error) { console.error(error); return json({ error: "db" }, 500); }
  return json({ ok: true });
});
