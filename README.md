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

### 3. Turn on AI blurb drafts
1. Get an API key at [console.anthropic.com](https://console.anthropic.com) and set a monthly spend limit there (a few dollars is plenty; each draft costs about a cent).
2. In Supabase: **Edge Functions → Secrets**, add `ANTHROPIC_API_KEY` with your key. Optionally add `ALLOWED_ORIGIN` = `https://hereiszee.github.io` so only your site can call it.
3. **Edge Functions → Deploy a new function → Via editor.** Name it exactly `draft-blurb`, paste in `supabase/functions/draft-blurb/index.ts`, and deploy.
4. Open the function's settings and turn **off** "Verify JWT" (families aren't signed in; the function has its own rate limit).

### 4. Connect the site
In **Project Settings → API**, copy the **Project URL** and the **publishable** (or "anon public") key into `config.js`. Both are safe to be public. Never paste the secret / service-role key.

## Notes
- Families can only *add* profiles. Reading, exporting and deleting require signing in with an email listed in `dashboard_admins`.
- Photos are resized in the browser to roughly 1 MB before upload and kept in a private bucket.
- Each family's progress is saved in their own browser until they submit.
