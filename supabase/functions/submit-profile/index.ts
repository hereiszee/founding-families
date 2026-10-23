// Supabase Edge Function: submit-profile
// Receives a family's profile from the form, checks it, enforces a per-IP limit and a site-wide
// daily cap, and saves it.
// Uses the project's built-in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY secrets (set automatically).
// Recommended secret: IP_SALT (a long random string) so stored IP hashes can't be reversed.
// Optional secrets: MAX_PER_IP (default 2), ALLOWED_ORIGIN (e.g. https://yourname.github.io).
// The daily cap uses bump_usage() from hardening.sql.

import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_PER_IP = (() => {
  const n = Number(Deno.env.get("MAX_PER_IP") ?? "2");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
})();
const DAILY_CAP = 30; // submissions per UTC day, whole site
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const BUCKET = "family-photos";
const NAME_MAX = 120;
const MAX_KIDS = 20;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_B64 = Math.ceil(MAX_PHOTO_BYTES / 3) * 4;
const MAX_BODY = MAX_PHOTO_B64 + 200_000;

const IP_SALT = Deno.env.get("IP_SALT") ?? "";
if (!IP_SALT) console.warn("submit-profile: IP_SALT secret is not set, so IP hashes use the public fallback salt");
const SALT = IP_SALT || "founding-families";

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
  if (!ip.includes(":")) return ip;
  let parts: string[];
  if (ip.includes("::")) {
    const [a, b] = ip.split("::");
    const head = a ? a.split(":") : [], tail = b ? b.split(":") : [];
    parts = [...head, ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  } else parts = ip.split(":");
  return parts.slice(0, 4).join(":") + "::/64";
}

async function hashIp(key: string) {
  // Stored hashed so the table never holds raw addresses.
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT + "|" + key));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- validation ----------
const PHONE_RE = /^[+0-9 ().-]+$/;
const EMAIL_RE =
  /^[^\s\x00-\x1f\x7f@,;?&%<>"\\]{1,64}@(?:[^\s\x00-\x1f\x7f@,;?&%<>"\\.]+\.)+[^\s\x00-\x1f\x7f@,;?&%<>"\\.]{2,}$/;
function validContact(c: string): boolean {
  if (!c || c.length > 200) return false;
  if (PHONE_RE.test(c)) {
    const digits = c.replace(/\D/g, "").length;
    return digits >= 7 && digits <= 16;
  }
  if (!EMAIL_RE.test(c)) return false;
  const local = c.slice(0, c.indexOf("@"));
  return !c.includes("..") && !local.startsWith(".") && !local.endsWith(".");
}

function validAge(a: string): boolean {
  if (a === "") return true;
  if (!/^(\d{1,2}(\.\d{1,3})?|\.\d{1,3})$/.test(a)) return false;
  const n = Number(a);
  return n >= 0 && n <= 25;
}

type Kid = { name: string; age: string };
function parseKids(v: unknown): Kid[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_KIDS) return null;
  const out: Kid[] = [];
  for (const k of v) {
    if (!k || typeof k !== "object") return null;
    const rec = k as Record<string, unknown>;
    const name = str(rec.name, 80);
    const age = typeof rec.age === "number" ? String(rec.age)
      : typeof rec.age === "string" ? rec.age.trim()
      : rec.age === undefined || rec.age === null ? "" : null;
    if (age === null || !validAge(age)) return null;
    if (name || age) out.push({ name, age });
  }
  return out;
}

type Photo = { bytes: Uint8Array; type: string; ext: string };
function sniff(b: Uint8Array): { type: string; ext: string } | null {
  const at = (sig: number[], off = 0) => b.length >= off + sig.length && sig.every((v, i) => b[off + i] === v);
  if (at([0xff, 0xd8, 0xff])) return { type: "image/jpeg", ext: "jpg" };
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: "image/png", ext: "png" };
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return { type: "image/webp", ext: "webp" };
  return null;
}
// A base64 data URL from the form. Checked by size and by the file's real first bytes, not its label.
function decodePhoto(s: string): Photo | null {
  if (!s || s.length > MAX_PHOTO_B64 + 40) return null;
  const m = s.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) return null;
  let bin: string;
  try { bin = atob(m[2]); } catch { return null; }
  if (!bin.length || bin.length > MAX_PHOTO_BYTES) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const kind = sniff(bytes);
  if (!kind || kind.type !== `image/${m[1]}`) return null;
  return { bytes, ...kind };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return json({ error: "bad_photo" }, 400);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_request" }, 400);

  // ----- validate everything before touching the database -----
  const name = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const family_name = name(body.familyName), husband = name(body.husband), wife = name(body.wife);
  if (![family_name, husband, wife].every((s) => s.length >= 1 && s.length <= NAME_MAX)) {
    return json({ error: "missing_names" }, 400);
  }

  const contact = name(body.contact);
  if (!validContact(contact)) return json({ error: "bad_contact" }, 400);

  const points = (Array.isArray(body.points) ? body.points : [])
    .map((p) => str(p, 300)).filter(Boolean).slice(0, 30);
  if (!points.length) return json({ error: "no_points" }, 400);

  const kids = parseKids(body.kids);
  if (!kids) return json({ error: "bad_kids" }, 400);

  const photo = decodePhoto(typeof body.photo === "string" ? body.photo : "");
  if (!photo) return json({ error: "bad_photo" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // ----- per-IP limit -----
  const ip = clientIp(req);
  const ipHash = ip ? await hashIp(rateKey(ip)) : null;
  if (!ipHash) console.warn("submit-profile: no client IP on the request, per-IP limit skipped");
  if (ipHash) {
    const { count, error: countErr } = await sb.from("families")
      .select("id", { count: "exact", head: true }).eq("ip_hash", ipHash);
    if (countErr) { console.error(countErr); return json({ error: "db" }, 500); }
    if ((count ?? 0) >= MAX_PER_IP) return json({ error: "limit_reached" }, 429);
  }

  // ----- site-wide daily cap (fails open: a counter problem shouldn't lose a family's form) -----
  try {
    const { data: within, error: capErr } = await sb.rpc("bump_usage", { p_bucket: "submit-profile", p_cap: DAILY_CAP });
    if (capErr) console.error("bump_usage failed, letting the submission through", capErr);
    else if (within !== true) return json({ error: "daily_cap" }, 429);
  } catch (e) {
    console.error("bump_usage failed, letting the submission through", e);
  }

  // ----- save: photo to the private bucket, then the row -----
  const id = crypto.randomUUID();
  const photo_path = `${id}.${photo.ext}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(photo_path, photo.bytes, { contentType: photo.type });
  if (upErr) { console.error(upErr); return json({ error: "photo_upload" }, 500); }

  const { error } = await sb.from("families").insert({
    id, lang: body.lang === "he" ? "he" : "en",
    family_name, husband, wife, contact,
    kids, points, blurb: str(body.blurb, 4000), photo_path, source: "form", ip_hash: ipHash,
  });
  if (error) {
    console.error(error);
    await sb.storage.from(BUCKET).remove([photo_path]);
    return json({ error: "db" }, 500);
  }

  // Two requests from one address can both pass the count above at the same moment.
  // Keep only that address's first MAX_PER_IP rows, so the limit holds even then.
  if (ipHash) {
    const { data: first, error: raceErr } = await sb.from("families").select("id")
      .eq("ip_hash", ipHash).order("created_at", { ascending: true }).order("id", { ascending: true })
      .limit(MAX_PER_IP);
    if (raceErr) console.error(raceErr);
    else if (!(first ?? []).some((r: { id: string }) => r.id === id)) {
      await sb.from("families").delete().eq("id", id);
      await sb.storage.from(BUCKET).remove([photo_path]);
      return json({ error: "limit_reached" }, 429);
    }
  }

  return json({ ok: true, id });
});
