# EarnTime Microsite

Static HTML landing page for the EarnTime app. Two pages: `/` (landing) and `/privacy` (privacy policy required for Play Store and App Store submission).

**Target domain:** `earntime.c-lab.co.uk`  
**Deploy target:** Vercel (static, no framework/build step)

---

## Deploy to Vercel

### First time

1. Push this repo to GitHub under the `c-lab` org (or your personal account).
2. Go to [vercel.com](https://vercel.com) → Add New Project → import the GitHub repo.
3. In the project settings Vercel will detect it's a static site automatically (no framework). Leave build command and output directory blank.
4. Click Deploy.
5. Vercel assigns a preview URL like `earntime-microsite-xyz.vercel.app`. Confirm it works.

### Add the custom domain

1. In Vercel → your project → Settings → Domains → Add `earntime.c-lab.co.uk`.
2. Vercel shows you a CNAME record to add. It will be something like:
   ```
   CNAME  earntime  cname.vercel-dns.com
   ```

### Configure DNS at names.co.uk

`c-lab.co.uk` DNS is managed at **names.co.uk** (login with the c-lab account).

1. Log in → Domains → `c-lab.co.uk` → DNS Management.
2. Add a new CNAME record:
   - **Host / Name:** `earntime`
   - **Points to / Value:** `cname.vercel-dns.com` (confirm the exact value Vercel shows — it may differ)
   - **TTL:** 3600 (1 hour)
3. Save. DNS propagates in 5–60 minutes.
4. Back in Vercel → Domains — the domain should go green once propagation is done and Vercel has issued the SSL certificate.

### Future deploys

Push to `main` → Vercel auto-deploys. No manual steps needed.

---

## Content updates

| What to update | File |
|---|---|
| App Store / Play Store links | `index.html` — find the `badge-soon` spans, change to `<a>` tags and remove the `badge-soon` class |
| Privacy policy contact address | `privacy.html` — replace `[Company registered address — to be completed]` |
| Privacy policy date | `privacy.html` — update the `Last updated` line |
| Screenshots / hero image | Add image to repo root, reference in `index.html` |

---

## Related projects

- **App source:** `/Users/howard.boland/ScreenTimeQuiz` (Flutter, Firebase `screentime-57c87`)
- **c-lab main site:** `/Users/howard.boland/Documents/Git/c-lab/website` (Astro, deployed to AWS CloudFront + S3)
- **Firebase project:** `screentime-57c87` (Blaze, us-central1) — Cloud Function `generateQuiz` is live
