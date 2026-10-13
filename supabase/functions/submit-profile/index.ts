// Supabase Edge Function: submit-profile
// Receives a family's profile from the form, enforces a per-IP limit, and saves it.
// Uses the project's built-in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY secrets (set automatically).
// Optional secrets: MAX_PER_IP (default 2), ALLOWED_ORIGIN (e.g. https://hereiszee.github.io).

import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_PER_IP = Number(Deno.env.get("MAX_PER_IP") ?? "2");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const BUCKET = "family-photos";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function hashIp(ip: string) {
  // Stored hashed so the table never holds raw addresses.
  const salt = Deno.env.get("IP_SALT") ?? "founding-families";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + ip));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipHash = await hashIp(ip);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const family_name = str(body.familyName, 120);
  if (!family_name) return json({ error: "missing_family_name" }, 400);

  // Per-IP limit.
  const { count, error: countErr } = await sb.from("families")
    .select("id", { count: "exact", head: true }).eq("ip_hash", ipHash);
  if (countErr) { console.error(countErr); return json({ error: "db" }, 500); }
  if ((count ?? 0) >= MAX_PER_IP) return json({ error: "limit_reached" }, 429);

  const kids = (Array.isArray(body.kids) ? body.kids : []).slice(0, 20)
    .map((k: any) => ({ name: str(k?.name, 80), age: str(String(k?.age ?? ""), 4) }))
    .filter((k) => k.name || k.age);
  const points = (Array.isArray(body.points) ? body.points : []).map((p) => str(p, 300)).filter(Boolean).slice(0, 30);

  // Photo: a base64 JPEG data URL from the form, stored in the private bucket.
  let photo_path: string | null = null;
  const id = crypto.randomUUID();
  const photo = typeof body.photo === "string" ? body.photo : "";
  if (photo) {
    const m = photo.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!m || m[1].length > 4_000_000) return json({ error: "bad_photo" }, 400);
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    const { error } = await sb.storage.from(BUCKET).upload(`${id}.jpg`, bytes, { contentType: "image/jpeg" });
    if (error) { console.error(error); return json({ error: "photo_upload" }, 500); }
    photo_path = `${id}.jpg`;
  }

  const { error } = await sb.from("families").insert({
    id, lang: body.lang === "he" ? "he" : "en",
    family_name, husband: str(body.husband, 120), wife: str(body.wife, 120), contact: str(body.contact, 200),
    kids, points, blurb: str(body.blurb, 4000), photo_path, source: "form", ip_hash: ipHash,
  });
  if (error) {
    console.error(error);
    if (photo_path) await sb.storage.from(BUCKET).remove([photo_path]);
    return json({ error: "db" }, 500);
  }
  return json({ ok: true, id });
});
