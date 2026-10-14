import axios from 'axios';
import { BROWSER_HEADERS, SLUG_PATTERN } from '../engine.ts';

export interface ChannelInfo {
  slug: string;
  username: string;
  avatarUrl: string | null;
  isLive: boolean;
  title: string | null;
  viewers: number;
  category: string | null;
  startedAt: string | null;
}

export function normalizeSlug(value: unknown): string | null {
  const slug = String(value ?? '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\/(www\.)?kick\.com\//, '').split(/[/?#]/)[0];
  return SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Kick'in herkese açık kanal uç noktası. Cloudflare yalnız motorun test
 * edilmiş minimal başlıklarıyla geçiyor — başlık eklenmemeli.
 */
export async function fetchChannel(slug: string): Promise<ChannelInfo> {
  const res = await axios.get(`https://kick.com/api/v2/channels/${slug}`, { headers: BROWSER_HEADERS, timeout: 10_000 });
  const d = res.data ?? {};
  const live = d.livestream ?? null;
  return {
    slug,
    username: d.user?.username || slug,
    avatarUrl: d.user?.profile_pic || null,
    isLive: !!live,
    title: live?.session_title || null,
    viewers: live?.viewer_count || live?.viewers || 0,
    category: live?.categories?.[0]?.name || null,
    startedAt: live?.start_time || live?.created_at || null,
  };
}
