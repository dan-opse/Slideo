// Confirmed accounts on the local Supabase stack, for tests of the hosted
// studio's routes. Each is signed in the way the studio's sign-in route
// does: the session lands in cookies that later requests carry.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { localStack } from "./database";

export type User = {
  id: string;
  email: string;
  cookie: string;
  // What a browser holding this session could call directly.
  client: SupabaseClient;
};
const users: User[] = [];
let admin: SupabaseClient | undefined;
// The stack's admin API, with its secret key.
export function adminClient() {
  const stack = localStack();
  return (admin ??= createClient(stack.API_URL, stack.SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}

export async function signedInUser(name: string): Promise<User> {
  const stack = localStack();
  const email = `${name}-${Date.now()}@example.com`,
    password = `pw-${randomBytes(9).toString("hex")}`;
  const created = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  const jar = new Map<string, string>();
  const session = createServerClient(stack.API_URL, stack.PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) =>
        list.forEach(({ name, value }) =>
          value ? jar.set(name, value) : jar.delete(name),
        ),
    },
  });
  const { data, error } = await session.auth.signInWithPassword({
    email,
    password,
  });
  assert.ifError(error);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(jar.size, "the sign-in set session cookies");
  const client = createClient(stack.API_URL, stack.PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${data.session!.access_token}` },
    },
  });
  const user = {
    id: data.user!.id,
    email,
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    client,
  };
  users.push(user);
  return user;
}
// Deletes every account signedInUser made.
export async function deleteUsers() {
  for (const user of users.splice(0))
    await adminClient().auth.admin.deleteUser(user.id);
}
