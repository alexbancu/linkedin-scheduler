import { DEFAULTS } from './config';
import type { SettingsMap } from './types';

export async function getSettings(env: Env): Promise<SettingsMap> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map: SettingsMap = { ...DEFAULTS };
  for (const row of results) map[row.key] = row.value;
  return map;
}
export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}
