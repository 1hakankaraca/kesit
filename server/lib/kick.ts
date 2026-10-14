import axios from 'axios';
import { BROWSER_HEADERS, SLUG_PATTERN } from '../engine.ts';

export interface ChannelInfo {
  slug: string;
  /** Kanal sahibinin Kick kullanıcı kimliği (sohbet API'si bunu ister). */
  userId: number | null;
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
    userId: Number(d.user_id) || null,
    username: d.user?.username || slug,
    avatarUrl: d.user?.profile_pic || null,
    isLive: !!live,
    title: live?.session_title || null,
    viewers: live?.viewer_count || live?.viewers || 0,
    category: live?.categories?.[0]?.name || null,
    startedAt: live?.start_time || live?.created_at || null,
  };
}

export interface ChannelHit {
  slug: string;
  username: string;
  avatarUrl: string | null;
  followers: number;
  isLive: boolean;
  verified: boolean;
}

/** Kick'in herkese açık kanal araması (kanal seçici için). */
export async function searchChannels(q: string): Promise<ChannelHit[]> {
  const res = await axios.get('https://kick.com/api/search', { params: { searched_word: q }, headers: BROWSER_HEADERS, timeout: 8_000 });
  const channels: any[] = res.data?.channels ?? [];
  return channels
    .filter((c) => c?.slug && !c.is_banned)
    .slice(0, 8)
    .map((c) => ({
      slug: c.slug,
      username: c.user?.username || c.slug,
      avatarUrl: c.user?.profilePic || c.user?.profile_pic || null,
      followers: c.followers_count ?? c.followersCount ?? 0,
      isLive: !!c.isLive,
      verified: !!c.verified,
    }));
}
