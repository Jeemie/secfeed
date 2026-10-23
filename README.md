# SecFeed

A swipeable, Reels-style brief of IT and cybersecurity news for the first 5–10 minutes of your day or shift.

- **10–15 cards, then it stops.** You get a "You're caught up" screen, not an endless scroll.
- **News, ranked.** Pulled from BleepingComputer, The Hacker News, Krebs, SecurityWeek, Dark Reading, The Register, SANS ISC and CISA. Duplicate coverage of the same story is merged into one card, and actively exploited or critical issues rise to the top.
- **CISA KEV card.** Vulnerabilities added to CISA's Known Exploited Vulnerabilities catalog this week, with due dates.
- **Tutorials.** Recent YouTube videos from NetworkChuck, John Hammond, David Bombal, Professor Messer, IppSec and others, embedded rather than downloaded.
- **Reddit.** Top daily threads from r/sysadmin, r/netsec and r/cybersecurity.
- **Daily 3 quiz.** One question built from this week's KEV additions plus two from a 42-question bank (networking, AD, Linux, crypto, IR, cloud). It tracks your streak.
- **Topic filters, saved items, share, dark/light themes, works offline.**
- **Free to run.** No server and no AI credits unless you opt in.

## How it works

```
GitHub Actions (every 2 hours)            GitHub Pages                 Your phone
scripts/build-feed.mjs ── fetches RSS ──▶  data/feed.json  ◀── reads ──  the app (installed to home screen)
                          KEV, YouTube,    + the app files
                          Reddit; ranks it
```

Your phone never talks to the news sites directly. GitHub does the fetching on a schedule and publishes one small JSON file.

## Setup (about 15 minutes, on a computer)

1. **Create the repo.** On github.com click **New repository**, name it `secfeed`, choose **Public** and click **Create repository**.
   (Public is what makes Actions and Pages free. The content is public news anyway.)
2. **Upload the files.** On the new repo page click **uploading an existing file**, then drag in everything from this folder, *including the hidden `.github` folder*. Click **Commit changes**.
   - On a Mac, press `Cmd + Shift + .` in Finder to show hidden folders.
   - If `.github` won't upload, use **Add file → Create new file**, type `.github/workflows/update.yml` as the name, paste in the contents of that file, and commit.
3. **Turn on Pages.** Go to **Settings → Pages**. Under *Build and deployment → Source*, choose **GitHub Actions**.
4. **Run it once.** Go to the **Actions** tab (click *I understand… enable* if asked), choose **Update feed**, then **Run workflow**. It takes about a minute. A green check means it worked.
5. **Open it on your phone** at `https://YOUR-USERNAME.github.io/secfeed/`
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** (or **Install app**)
   - **iPhone (Safari):** Share button → **Add to Home Screen**

From then on it refreshes itself every 2 hours.

## Optional: AI summaries for the top 3 stories

Off by default. When it's on, the updater writes a 3-bullet TL;DR and a "do this today" line for the 3 highest-ranked stories. Each story is summarized **once**, cached, and shown to everyone who opens the app, so viewers never trigger a charge. At Claude Haiku 5.5 pricing, expect a few cents a month.

1. Create an API key at console.anthropic.com and add some prepaid credit.
2. In your repo go to **Settings → Secrets and variables → Actions → New repository secret**.
3. Name: `ANTHROPIC_API_KEY`, Value: your key. Save.

The next run picks it up. To turn it off again, delete the secret.

## Customizing (works from the GitHub app or mobile browser too)

Open a file on github.com, tap the pencil icon, edit, and commit. Every commit triggers a fresh build.

| What | Where |
|---|---|
| Add or remove news feeds, YouTube channels, subreddits | `scripts/sources.json` |
| How often it updates | `cron` line in `.github/workflows/update.yml` |
| Quiz questions | `scripts/quiz-bank.json` |
| Which topics, deck size (10/12/15), videos on or off | The app's settings button (saved on your phone) |

YouTube channels can be listed by `handle` alone (the part after `@` in the channel URL). The updater looks up the channel ID itself.

## Good to know

- **Any source can fail without breaking the app.** It's skipped and the rest still publish. The app's settings screen lists the status of every source from the last run. If *every* news source fails, the run stops and the previous feed stays live.
- **Reddit sometimes blocks automated requests from cloud servers.** When that happens, Reddit cards just don't appear.
- **GitHub pauses scheduled workflows in public repos after 60 days with no repo activity.** GitHub emails you first; one click on the Actions tab (or any commit) turns it back on.
- **Your saved items, history and settings live on your phone only.** There are no accounts. Clearing site data resets them.

## Run it locally (optional)

Requires Node 20+. No `npm install` needed.

```bash
node scripts/build-feed.mjs                    # fetch live sources → data/feed.json
python3 -m http.server 8080                    # then open http://localhost:8080
node scripts/build-feed.mjs --fixtures test/fixtures --now 2026-10-23T11:00:00Z   # offline test data
```
