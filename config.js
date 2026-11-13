// ===== Smart Navigation settings — fill these in once (see README.md, step 2) =====
window.SN_CONFIG = {
  // Supabase → Project Settings → API → "Project URL"
  SUPABASE_URL: 'https://denefdvddluvbolduaeg.supabase.co',

  // Supabase → Project Settings → API → "anon public" key.
  // This key is meant to be public; the database rules keep everyone's data private.
  // NEVER put the "service_role" key here.
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlbmVmZHZkZGx1dmJvbGR1YWVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1MjUxOTcsImV4cCI6MjExMDEwMTE5N30.ViyyDX47s_48q2FdKwKYe1_FdSR65c6ZqSB06w7aZ2M',

  // Your own sign-in email. Only this account sees the Manage Team screen.
  // (The server checks this too, using the OWNER_EMAIL secret.)
  OWNER_EMAIL: 'gavin.eastman@jjgaming.com',

  // The shop: every route starts here and finishes back here.
  SHOP_NAME: 'Shop',
  SHOP_ADDRESS: '604 Fort Crook Rd N, Bellevue, NE 68005, United States',
  // Optional, for pin-point accuracy: in Google Maps, right-click (or long-press) the shop,
  // click the numbers at the top of the menu to copy them, and paste them here, e.g. 41.1600, -95.9100.
  // Leave as null and the app looks the address up automatically.
  SHOP_LAT: null,
  SHOP_LNG: null,

  // Link to the main SMART work-orders app
  WORK_ORDERS_URL: 'https://gamingmobile.jjventures.com/service',
};
