# Smart Navigation

Route planner for the SMART team (J&J Ventures Gaming), an add-on to *My Work Orders – SMART*.
It installs from a link on iPhone and Android. There's no App Store and no sign-up page: only accounts you create can get in.

## What it does
- **Routes:** each person has their own private list of routes, saved online. Every route starts and finishes at the shop (604 Fort Crook Rd N, Bellevue, NE).
- **My Routes:** any route that isn't completed is pinned at the top with an orange, pulsing **⚠️ NOT COMPLETED** banner ("in progress since…" or "not started yet"). Close the app mid-day, reopen it, tap it and carry on. Below that are only the routes you completed and chose to save.
- **✔ Complete:** appears once a route is started. It asks **Save route** (kept in My Routes, view-only, and can be duplicated or reopened) or **Don't save** (deleted forever, after a second tap).
- **New route pop-up:** the route settings (name, date, start time — 8:00 AM by default — and "How many collectors are on route today?" — 2 by default) appear first, before anything else. You can change them later with ☰.
- **Reorder stops by dragging:** press and hold a stop (finger or mouse) for about half a second, then drag it up or down. **Move → position** inside a stop still works too. Afterwards, tap **Keep my order** to refresh the times.
- **Animations** (made in Lottie AI): a moving map behind sign-in, a portal into the map after signing in, "Finding the best route…" while optimizing, a ✔ pop when a stop is marked done, and the car pulling into the shop when a route is completed and saved. All of them are skipped on phones with "reduce motion" on.
- **Opening animation:** a car drives the route and drops the SMART pin. It plays the first time the app is opened each day, you can tap to skip it, and it's skipped if the phone has "reduce motion" on.
- **🗑 on each route** in My Routes asks "Delete *route name*?" with Yes / No.
- On the route page, **🕗 Planned start → Change** adjusts the time later, and **▶ Start route** records when you really leave, so every ETA is recalculated from that moment.
- **📍 Locations tab:** the shared list of all J&J locations, with search, a city filter, and "Settings needed", "Access anytime" and "Incomplete" filters. Everyone can view and edit them.
- **Location profile:** address, phone, account manager, hours (today in bold), contacts with Call / Text / Email buttons, every machine listed separately (duplicates kept), notes, account details, and who changed it last.
- **Location editor:** change any field, add or remove contacts and machines, set hours, and set a map point from where you're standing. If two people edit at once, the second save is refused with a "reload" message, so nobody overwrites anyone.
- **Adding stops:** use **📍 From locations** (multi-select), search by location name, or use any address, a pasted list, or an Excel/CSV file.
- **Business hours:** Optimize only plans a location while it's open and the service can finish before closing. After-midnight closings count for the day before, and split hours work. It visits open stops first. Locations whose hours aren't filled in yet still say **Hours unknown**, but routes treat them as open any time. A stop it can't fit (closed that day, or can't finish before closing) is marked **Not scheduled**.
- **⚠️ Attention needed:** if a location isn't open yet at your start time, its stop pulses orange and asks "Can you get in early?" (🔑 Yes, we can get in / ⏰ No, wait till open). **Optimize won't run until it's answered.** Locations that are already open, open 24/7, have no hours on file (treated as open 24/7), or are marked "access any time" never ask. Each stop has one **Hours** section with the question and a 🔑 Yes / ⏰ No choice.
- **Hours bypass:**
  - *Per location:* "We can get in any time" (🔑 key, 🔢 door code, or 📞 call owner). That location is always schedulable. The code itself is never stored.
  - *Per stop:* "Ignore business hours for this stop today."
- **Strict service time:** skill games ×3, each RT's task (**Fill 5 is the default**, Swap 10, None 0, summed per terminal), Non-ACH 7, and payout tickets 12 (only without an RT).
  - Crew 1 = everything. Crew 2 = everything except RT. Crew 3 = half of everything, rounded up.
  - **Skill games count automatically** from the machines on the location's equipment list, and **every location is ACH unless someone marks it Non-ACH**. Anyone can change either on the location's page.
  - Only an unknown **payout tickets** setting (at locations without an RT) blocks Optimize. A "Fix these first" list takes you straight there.
- **Live ETAs:** an ETA and start time for each stop (including waits for opening), and the time you'll be back at the shop. Marking a stop **Done** shifts the rest of the day's times to match.
- **Activity log:** ⚙︎ → Recent location changes shows who changed what.
- **Navigation:** one tap to Navigate (Apple Maps, Google Maps or Waze), plus Call, Done / Failed / Skip with a note.
- **Look:** SMART colors throughout — navy `#054c88`, forest green `#347147`, light green `#8ebe42`, off-white `#f3f4f3`, black — plus dark mode and a link to My Work Orders – SMART. On a computer, buttons and cards light up when you hover over them. Pop-ups close by pulling their top handle down.
- **Stay signed in:** reopening or refreshing goes straight to My Routes; the sign-in screen only appears after **Sign out**.
- **Manage Team (hidden, only you):** add, reset, rename and remove accounts, plus the one-time location import.

---

## One-time setup (about 30–40 minutes, on a computer)

### 1. Create the database (free)
1. Go to **https://supabase.com**, sign up, and click **New project**. Name it `smart-navigation`, set a strong database password (save it somewhere), and pick the region closest to you (e.g. *Central US*).
2. Wait about 2 minutes for it to finish.

### 2. Create the tables
1. In your project, open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this folder, copy everything, paste it in, and click **Run**. You should see "Success".

### 3. Lock down sign-ups and create YOUR account
1. **Authentication → Sign In / Providers** (or *Settings*): turn **OFF** "Allow new users to sign up". Leave **Email** provider on.
2. **Authentication → Users → Add user → Create new user**: enter your email and a password, and tick **Auto Confirm User**. This is the owner account.

### 4. Install the team-management function
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly **`manage-team`**.
3. Delete the sample code, paste all of `supabase/functions/manage-team/index.ts`, and click **Deploy**.
4. **Edge Functions → Secrets → Add new secret**: Name `OWNER_EMAIL`, Value = the email from step 3. Click **Save**.

### 5. Connect the app to the database
1. **Project Settings → API** (or *API Keys*). Copy the **Project URL** and the **anon / public** key. A newer "publishable" key (starts with `sb_publishable_`) also works.
   ⚠️ Never use the **service_role** / secret key in the app.
2. Open `config.js` in a text editor (Notepad or TextEdit), fill in the three values, and save:
   ```js
   SUPABASE_URL: 'https://xxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJ...',
   OWNER_EMAIL: 'your@email.com',
   ```
   The shop address is already filled in (`SHOP_ADDRESS`). The app looks it up on the map automatically. For pin-point accuracy, you can also paste the shop's exact coordinates into `SHOP_LAT` / `SHOP_LNG`: in Google Maps, right-click (or long-press) the shop and copy the numbers at the top.

### 6. Put the app online (GitHub Pages, free)
1. Create a free account at **https://github.com**.
2. Click **+ → New repository**, name it `smart-navigation`, choose **Public**, and click **Create repository**.
   (Public is fine. These files have no customer data or passwords, and the anon key is designed to be public. Everyone's routes stay locked in the database behind their login.)
3. Click **uploading an existing file**. Drag in **everything in this folder** (including the `icons` folder; the `supabase` folder is optional), then click **Commit changes**.
4. **Settings → Pages**: under *Branch*, pick `main` and `/ (root)`, then click **Save**.
5. After 1–2 minutes your app is at **`https://YOUR-GITHUB-NAME.github.io/smart-navigation/`**.

### 7. Add your 13 coworkers
1. Open the link and sign in with your owner account. Go to **⚙︎ Settings**, scroll to the bottom, and **tap the "Smart Navigation v2.4" line 7 times quickly**. Manage Team opens.
   There's no button for it anywhere. For anyone else, tapping that line does nothing, and the server refuses them too.
2. For each person, enter their name and email, tap **Generate** for a password, then tap **Create account**. Use **Copy** to send them their login.

### 8. Coworkers install it
- **iPhone:** open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open the link in **Chrome** → ⋮ → **Install app**.
It opens full-screen with the Smart Navigation icon, like a regular app.

---

## Update 1.2 — locations (do this once)
1. **Supabase → SQL Editor → New query.** Paste all of `supabase/002_locations.sql` and click **Run**. Approve the warning if one appears. It should end with "Success". It's safe to run twice.
2. **GitHub → your repo → Add file → Upload files.** Drag in these files from this folder: `index.html`, `app.js`, `logic.js`, `locations.js` (new), `styles.css`, `sw.js`, `config.js`, `README.md`. Then click **Commit changes**.
3. Open the app and sign in as yourself. Go to ⚙︎ Settings and tap the **"Smart Navigation v1.x"** line at the bottom 7 times. In **Import locations**, choose `source.json` from your SMART-Navigation **data** folder. In about 30 seconds you should see **543 locations, 430 contacts, 2538 devices**. Import only runs while the list is empty, so it can't overwrite anyone's edits.
4. Skill games and ACH fill themselves in. Only locations **without an RT** need payout tickets set (one tap on the location's page) before they can be optimized.
   ⚠️ Never upload `source.json` or the spreadsheet to GitHub: that site is public. The import sends the data straight to your private database.

## Update 1.3 → 1.6 — start / complete / save routes, Fill default, new-route settings, delete button, drag to reorder (do this once)
1. **Supabase → SQL Editor → New query.** Paste `supabase/003_start_route.sql` (two short lines) and click **Run**. If you already ran an earlier copy of 003, run this one again; it's safe.
2. **GitHub → Add file → Upload files.** Upload `index.html`, `app.js`, `logic.js`, `locations.js`, `styles.css`, `sw.js`, `README.md`, then click **Commit changes**.
3. Fully close and reopen the app. The bottom of Settings should say **v2.0**.

## Update 2.0 / 2.1 — attention needed (do this once)
1. **Supabase → SQL Editor → New query.** Paste `supabase/004_hours_answer.sql` (two short lines) and click **Run**. Also run `003_start_route.sql` if you never did.
2. **GitHub → Add file → Upload files.** Upload `index.html`, `app.js`, `locations.js`, `styles.css`, `sw.js`, `README.md`, plus the `anim` folder if you haven't uploaded it since v1.9. Then click **Commit changes**.
3. Refresh. Settings should say **v2.1**. If My Routes shows an orange **"Database update needed"** box, run the SQL file(s) it names. Your routes are safe; they just can't be started or completed until then.

## Update 2.4 — account managers (automatic)
Upload `index.html`, `locations.js`, `sw.js` and `README.md` to GitHub. The first time anyone opens v2.4, the app updates account managers **once**:
- Locations with **no account manager and no customer service rep** → **Anthony Bukoskie, (531) 210-7409**
- Locations with **Leo Akselrud** or **Rob Dolrenry** → that location's customer service rep, or **Anthony Bukoskie** if it has none

Every change is listed under ⚙︎ Settings → **Recent location changes**. It never runs again, so later edits stay. (`supabase/update_account_managers.sql` does the same thing by hand; there's no need to run it as well.)

## Good to know
- **Removing someone** (hidden Manage Team → Remove) takes effect immediately. Their routes are deleted, and the app signs them out the next time it's opened or brought back on screen.
- **Passwords:** the app has no change-password or forgot-password option, so only you can reset them.
- **Updating the app:** upload the changed files to the same GitHub repo. Phones pick up the new version the next time the app is opened.
- **Free services:** address search uses OpenStreetMap (Photon/Nominatim), and drive times come from the public OSRM server. Both are free and fine for a 14-person team, but neither has a guaranteed uptime. If OSRM is down, the app falls back to a straight-line estimate. Live traffic isn't needed: Apple/Google Maps handle traffic while driving, and the app's ETAs re-adjust every time a stop is marked Done.
- **Supabase free plan** pauses a project after a week with **no** use at all. Daily use keeps it awake.
- **Hours rules:** "-", blank, "22" and equal open/close times (e.g. "12:00 AM - 12:00 AM") show as **Hours unknown** and are scheduled as if open any time. "Closed" days are respected.
- Customer data lives only in your private Supabase database, never in the public GitHub files.
