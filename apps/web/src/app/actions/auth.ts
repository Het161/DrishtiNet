'use server';

import { redirect } from 'next/navigation';

import { login, logout } from '@/lib/auth';

export async function loginAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!username || !password) return { error: 'Enter a username and password.' };

  const session = await login(username, password);
  // One message for both causes: telling an attacker which half was wrong is free information.
  if (!session) return { error: 'Incorrect username or password.' };

  redirect('/registry');
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect('/login');
}
