# Smart Navigation

Route planner for the SMART team (J&J Ventures Gaming), an add-on to *My Work Orders – SMART*.
It installs from a link on iPhone and Android. There's no App Store and no sign-up page: only accounts you create can get in.

## What it does
- **Routes:** each person has their own private list of routes, saved online so they're there on any phone they sign in from.
- **Adding stops:** search an address or business, paste a list, or import an Excel/CSV file. Columns it recognizes: *Location Name, Street Address, City, State, ZIP Code, Location Phone, Skill Game Count, Redemption Terminals, ACH, Payout Tickets, Notes*. Your old J&J spreadsheet layout works as-is.
- **Optimize:** finds the fastest order using real drive times (up to 98 stops). Every route **starts and finishes at the shop** (604 Fort Crook Rd N, Bellevue, NE). **Keep my order** recalculates times without reordering.
- **Times:** a map, total miles, drive time, an ETA at every stop and a finish time back at the shop that includes service time. When you mark a stop **Done**, the remaining ETAs shift to match: run 5 minutes late and everything after moves 5 minutes.
- **Service time:** your formula. Games ×3, RT Fill 5 / Swap 10, payout tickets 12 (blocked when there's an RT), Non-ACH 7, and 1–3 collectors. You can override the minutes on any stop.
- **Next stop card:** one tap to **Navigate** (Apple Maps, Google Maps or Waze) and **Done**. Stops can also be marked Failed or Skipped with a note, moved, duplicated, or reset.
- **Look:** dark mode, and a link to My Work Orders – SMART.
- **Manage Team (hidden, only you):** add accounts, reset passwords, rename, and remove people. Removing someone deletes their login and all of their routes immediately.

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
1. Open the link and sign in with your owner account. Go to **⚙︎ Settings**, scroll to the bottom, and **tap the "Smart Navigation v1.1" line 7 times quickly**. Manage Team opens.
   There's no button for it anywhere. For anyone else, tapping that line does nothing, and the server refuses them too.
2. For each person, enter their name and email, tap **Generate** for a password, then tap **Create account**. Use **Copy** to send them their login.

### 8. Coworkers install it
- **iPhone:** open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open the link in **Chrome** → ⋮ → **Install app**.
It opens full-screen with the Smart Navigation icon, like a regular app.

---

## Good to know
- **Removing someone** (hidden Manage Team → Remove) takes effect immediately. Their routes are deleted, and the app signs them out the next time it's opened or brought back on screen.
- **Passwords:** the app has no change-password or forgot-password option, so only you can reset them.
- **Updating the app:** upload the changed files to the same GitHub repo. Phones pick up the new version the next time the app is opened.
- **Free services:** address search uses OpenStreetMap (Photon/Nominatim), and drive times come from the public OSRM server. Both are free and fine for a 14-person team, but neither has a guaranteed uptime. If OSRM is down, the app falls back to a straight-line estimate. Live traffic isn't needed: Apple/Google Maps handle traffic while driving, and the app's ETAs re-adjust every time a stop is marked Done.
- **Supabase free plan** pauses a project after a week with **no** use at all. Daily use keeps it awake.
- Your old customer spreadsheet data is **not** included in this app.
