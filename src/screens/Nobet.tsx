import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { platformLabel } from '../components/PublishDialog.tsx';
import { Field, Pill, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { time } from '../lib/format.ts';
import { liveStore, refreshLive } from '../lib/live.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { AutopilotConfig, ChannelInfo, LiveState, ZernioSummary } from '../lib/types.ts';
import { useInterval, useResource } from '../lib/useResource.ts';
import { ChannelBanner } from './Live.tsx';

const STEPS = [
  { icon: 'clock', title: 'Yoklar', text: 'Sunucu kanalı belirli aralıklarla kontrol eder. Tarayıcın kapalı olabilir.' },
  { icon: 'live', title: 'Yayın açılınca', text: 'Chat\'e düşen klipler yakalanır ve istersen dikey videoya çevrilir.' },
  { icon: 'download', title: 'Yayın bitince', text: 'Yayının tamamı indirilir, Yayın geçmişleri\'nde seni bekler.' },
] as const;

/** Nöbet: bilgisayar başında değilken takip edilen kanalı izler. */
export function Nobet() {
  const { user } = useSession();
  const live = liveStore.use();
  const channel = live?.autopilot.config.channel || user?.channelSlug || '';
  const info = useResource(() => (channel ? api.get<ChannelInfo>(`/api/live/channel${query({ channel })}`) : Promise.resolve(null)), [channel]);
  useInterval(() => channel && void info.reload(), 60_000);

  useEffect(() => {
    void refreshLive();
  }, []);

  return (
    <>
      <WorkspaceHead title="Çevrimdışı" tape="bot takip" lead="Sen yokken bot kanalı izler: yayın açılınca klip yakalamaya başlar, yayın bitince yayını indirir ve her şeyi toparlar." guide="nobet" />
      <ol className="flow">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flow-step">
            <span className="flow-num">{i + 1}</span>
            <Icon name={s.icon} size={18} />
            <b>{s.title}</b>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
      {channel && <ChannelBanner info={info.data} loading={info.loading} channel={channel} />}
      {!live ? (
        <div className="center-pad">
          <Spinner size={24} />
        </div>
      ) : (
        <AutopilotPanel live={live} fallbackChannel={channel} />
      )}
    </>
  );
}

function AutopilotPanel({ live, fallbackChannel }: { live: LiveState; fallbackChannel: string }) {
  const status = live.autopilot;
  const [draft, setDraft] = useState<AutopilotConfig>(() => ({ ...status.config, channel: status.config.channel || fallbackChannel || null }));
  const [busy, setBusy] = useState(false);
  const [zernio, setZernio] = useState<ZernioSummary | null>(null);

  useEffect(() => {
    if (draft.autoPublish && !zernio) api.get<ZernioSummary>('/api/zernio').then(setZernio).catch(() => {});
  }, [draft.autoPublish, zernio]);

  const save = async (next: AutopilotConfig) => {
    setBusy(true);
    try {
      const res = await api.put<LiveState['autopilot']>('/api/autopilot', next);
      liveStore.set((s) => (s ? { ...s, autopilot: res } : s));
      setDraft(res.config);
      toast(res.config.enabled ? 'Bot takibi açık' : 'Bot takibi kapatıldı', 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const patch = (p: Partial<AutopilotConfig>) => {
    const next = { ...draft, ...p };
    setDraft(next);
    if (status.config.enabled) void save(next);
  };

  const accounts = (zernio?.accounts ?? []).filter((a) => a.platform !== 'tiktok');
  const toggleAccount = (platform: string, accountId: string) => {
    const has = draft.publishAccounts.some((a) => a.accountId === accountId && a.platform === platform);
    patch({ publishAccounts: has ? draft.publishAccounts.filter((a) => !(a.accountId === accountId && a.platform === platform)) : [...draft.publishAccounts, { platform, accountId }] });
  };

  const on = status.config.enabled;

  return (
    <section className={on ? 'panel autopilot autopilot-on' : 'panel autopilot'} aria-labelledby="ap-title">
      <span className="panel-tape" aria-hidden="true" />
      <header className="panel-head">
        <div>
          <h2 id="ap-title" className="panel-title">
            <Icon name="shield" size={18} /> Çevrimdışı bot takip
          </h2>
          <p className="panel-sub">Bilgisayar başında değilken kanalı yoklar; yayın açılınca devreye girer, kapanınca toparlar.</p>
        </div>
        {on && <Pill tone={status.live ? 'live' : 'on'}>{status.live ? 'Yayın sürüyor' : 'Bekliyor'}</Pill>}
      </header>

      <div className="stack">
        <Field label="Takip edilen kanal" htmlFor="ap-channel">
          <input
            id="ap-channel"
            className="input"
            value={draft.channel ?? ''}
            onChange={(e) => setDraft({ ...draft, channel: e.target.value.trim() || null })}
            placeholder="kanal adı"
            disabled={on}
          />
        </Field>
        <Switch
          checked={draft.downloadVod}
          onChange={(v) => patch({ downloadVod: v })}
          label="Yayın bitince yayını indir"
          hint="Kick yayın kaydını yayımlayınca indirilir ve Yayın geçmişleri'ne düşer; editörde sen düzenlersin, otomatik işlenmez"
        />
        <Switch checked={draft.clips} onChange={(v) => patch({ clips: v })} label="Chat kliplerini yakala" hint="Sohbete düşen kick.com ve kickbot.com klip bağlantıları" />
        {draft.clips && <Switch checked={draft.autoEdit} onChange={(v) => patch({ autoEdit: v })} label="Yakalananları otomatik düzenle" hint="Dikey video + altyazı, Galeri'ye düşer" />}
        {draft.clips && draft.autoEdit && <Switch checked={draft.subtitles} onChange={(v) => patch({ subtitles: v })} label="Altyazı" />}
        {draft.clips && draft.autoEdit && (
          <Switch checked={draft.autoPublish} onChange={(v) => patch({ autoPublish: v })} label="Otomatik paylaş" hint="Hazır klipler saatte bir Zernio ile paylaşılır" />
        )}
        {draft.autoPublish && (
          <div className="subtle-box">
            {!zernio ? (
              <Spinner />
            ) : !zernio.connected ? (
              <button type="button" className="link" onClick={() => navigate(sectionPath('paylasim'))}>
                Önce Zernio hesabını bağla
              </button>
            ) : (
              <div className="account-grid">
                {accounts.map((a) => {
                  const checked = draft.publishAccounts.some((x) => x.accountId === a.id && x.platform === a.platform);
                  return (
                    <label key={a.id} className={checked ? 'account account-on' : 'account'}>
                      <input type="checkbox" checked={checked} onChange={() => toggleAccount(a.platform, a.id)} />
                      <span className={`platform-badge platform-${a.platform}`}>{platformLabel(a.platform).slice(0, 2)}</span>
                      <span>
                        <b>{a.displayName}</b>
                        <small>{platformLabel(a.platform)}</small>
                      </span>
                    </label>
                  );
                })}
                <p className="field-help">TikTok her gönderide açık onay istediği için otomatik paylaşılamaz.</p>
              </div>
            )}
          </div>
        )}

        <button type="button" className={on ? 'btn btn-secondary btn-large' : 'btn btn-accent btn-large'} disabled={busy || (!on && !draft.channel)} onClick={() => save({ ...draft, enabled: !on })}>
          {busy ? <Spinner /> : <Icon name={on ? 'stop' : 'shield'} size={16} />}
          {on ? 'Takibi kapat' : 'Takibi başlat'}
        </button>
        {on && status.nextCheckAt && <p className="field-help">Son yoklama {time(status.lastCheckAt)} · sonraki {time(status.nextCheckAt)}</p>}
      </div>

      {status.events.length > 0 && (
        <ol className="event-log" aria-label="Takip günlüğü">
          {status.events.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`event event-${e.kind}`}>
              <span className="event-time">{time(e.at)}</span>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

