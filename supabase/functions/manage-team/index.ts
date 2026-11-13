// Supabase Edge Function: manage-team
// Lets ONLY the owner (the email in the OWNER_EMAIL secret) list, create,
// reset passwords for, and delete team accounts. Everyone else is refused.
//
// Deploy: Supabase dashboard → Edge Functions → "Deploy a new function" → "Via editor",
// name it exactly  manage-team , paste this file, Deploy.
// Then Edge Functions → Secrets → add  OWNER_EMAIL = your sign-in email.

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ownerEmail = (Deno.env.get('OWNER_EMAIL') || '').trim().toLowerCase();
  if (!ownerEmail) return json({ error: 'OWNER_EMAIL secret is not set on the server.' }, 500);

  // Who is calling?
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: 'Not signed in.' }, 401);
  if ((who.user.email || '').toLowerCase() !== ownerEmail) return json({ error: 'Only the app owner can manage accounts.' }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action;

  try {
    if (action === 'list') {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw error;
      const users = data.users.map((u) => ({
        id: u.id,
        email: u.email,
        name: (u.user_metadata as any)?.full_name || '',
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        is_owner: (u.email || '').toLowerCase() === ownerEmail,
      })).sort((a, b) => (a.is_owner ? -1 : b.is_owner ? 1 : (a.name || a.email || '').localeCompare(b.name || b.email || '')));
      return json({ users });
    }

    if (action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: name },
      });
      if (error) throw error;
      return json({ ok: true, id: data.user?.id });
    }

    if (action === 'reset') {
      const id = String(body.user_id || '');
      const password = String(body.password || '');
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === 'rename') {
      const id = String(body.user_id || '');
      const { error } = await admin.auth.admin.updateUserById(id, { user_metadata: { full_name: String(body.name || '').trim() } });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === 'delete') {
      const id = String(body.user_id || '');
      if (id === who.user.id) return json({ error: "You can't delete your own owner account." }, 400);
      // Deleting the user also deletes all their routes and stops (ON DELETE CASCADE).
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 400);
  }
});
