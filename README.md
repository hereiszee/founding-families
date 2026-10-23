# Founding families

A bilingual (English / Hebrew) intake form for families interested in founding a new community, plus a private dashboard to review what comes in.

- **Form:** `index.html`, the link you send to families
- **Dashboard:** `dashboard.html`, sign in to see every submission, photos included, and export a spreadsheet
- **Backend:** Supabase stores profiles and photos; a small Edge Function writes the blurb drafts with Claude

## One-time setup (about 15 minutes)

### 1. Create the Supabase project
1. Sign up at [supabase.com](https://supabase.com) and create a new project (the free plan is fine). Pick a region close to Israel, e.g. Frankfurt.
2. Open **SQL Editor → New query**, paste the whole of `supabase/setup.sql`, and click **Run**.
   This creates the table, the private photo bucket, and the access rules. If the dashboard should be opened from a different email, change it near the top of the file first.

### 2. Create your dashboard login
1. **Authentication → Users → Add user → Create new user.** Use the same email as in `dashboard_admins`, choose a password, and tick **Auto confirm user**.
2. **Authentication → Sign In / Providers:** turn off **Allow new users to sign up**. (Others couldn't see anything even if they signed up, but there's no reason to allow it.)

### 3. Add the two functions
Both go in via **Edge Functions → Deploy a new function → Via editor**. For each one, paste the file, deploy, then open its settings and turn **off** "Verify JWT" (families aren't signed in).

| Name (must match exactly) | File | What it does |
|---|---|---|
| `submit-profile` | `supabase/functions/submit-profile/index.ts` | Saves each submission and photo, and limits submissions per internet connection (2 by default) |
| `draft-blurb` | `supabase/functions/draft-blurb/index.ts` | Writes the blurb from the family's points using Claude |

Then under **Edge Functions → Secrets** add:
- `ANTHROPIC_API_KEY`: from [console.anthropic.com](https://console.anthropic.com). Set a monthly spend limit there; a few dollars is plenty, each draft costs about a cent.
- `ALLOWED_ORIGIN` = `https://hereiszee.github.io` (optional, so only your site can call the functions)
- `MAX_PER_IP` (optional, default `2`) to change the per-connection limit

### 4. Connect the site
In **Project Settings → API**, copy the **Project URL** and the **publishable** (or "anon public") key into `config.js`. Both are safe to be public. Never paste the secret / service-role key.

## Notes
- Families can only *add* profiles, and only through `submit-profile`. Reading, exporting and deleting require signing in with an email listed in `dashboard_admins`.
- The per-connection limit works on IP address, which is stored only as a salted hash. Keep in mind that a whole office, yeshiva or apartment building can share one IP, and someone on a phone gets a new one every so often. It stops casual duplicates, not a determined person.
- Photos are resized in the browser to roughly 1 MB before upload and kept in a private bucket.
- Each family's progress is saved in their own browser until they submit.
