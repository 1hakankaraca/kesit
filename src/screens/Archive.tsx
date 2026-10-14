import { useMemo, useState } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { platformLabel } from '../components/PublishDialog.tsx';
import { Empty, Segmented, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { bytes, dateTime, day, dayKey, duration, time } from '../lib/format.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import type { ArchiveDay, ArchiveEntry } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';
import { ChannelScopeToggle } from '../components/ChannelScopeToggle.tsx';
import { useChannelScope } from '../lib/channelScope.ts';

type Kind = 'all' | ArchiveEntry['kind'];

const KIND: Record<ArchiveEntry['kind'], { label: string; icon: IconName }> = {
  clip: { label: 'Klip', icon: 'vertical' },
  recording: { label: 'Kayıt', icon: 'record' },
  vod: { label: 'Yayın', icon: 'film' },
};

const HEAT_DAYS = 84;

/** Seçilen yerel günün UTC sınırları (sunucu ISO zaman damgası bekler). */
function dayBounds(key: string | null) {
  if (!key) return { from: null, to: null };
  const [y, m, d] = key.split('-').map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}

/**
 * Arşiv: üretilen ve paylaşılan her şeyin günlük defteri. Dosya silinse bile
 * kayıt, küçük görsel ve paylaşım geçmişi burada kalır.
 */
export function Archive() {
  const [kind, setKind] = useState<Kind>('all');
  const [q, setQ] = useState('');
  const [onlyDay, setOnlyDay] = useState<string | null>(null);
  const data = useResource(
    () => api.get<{ entries: ArchiveEntry[]; days: ArchiveDay[] }>(`/api/archive${query({ kind: kind === 'all' ? null : kind, q: q.trim() || null, ...dayBounds(onlyDay) })}`),
    [kind, q, onlyDay],
  );

  const { inScope } = useChannelScope();
  const entries = (data.data?.entries ?? []).filter((e) => inScope(e.channelSlug));

  const groups = useMemo(() => {
    const map = new Map<string, ArchiveEntry[]>();
    for (const e of entries) {
      const k = dayKey(e.producedAt);
      map.set(k, [...(map.get(k) ?? []), e]);
    }
    return [...map.entries()];
  }, [entries]);

  const totals = useMemo(() => {
    return {
      produced: entries.length,
      shared: entries.filter((e) => ['published', 'partial', 'scheduled'].includes(e.publishStatus ?? '')).length,
      deleted: entries.filter((e) => e.deletedAt).length,
      size: entries.filter((e) => e.fileAvailable).reduce((s, e) => s + (e.sizeBytes ?? 0), 0),
    };
  }, [entries]);

  return (
    <>
      <WorkspaceHead guide="arsiv" actions={<ChannelScopeToggle />} title="Arşiv" tape="defter" lead="Her gün ne üretildi, ne paylaşıldı, ne silindi. Dosyası silinmiş içeriklerin izi de burada durur." />

      <section className="panel heat-panel">
        <Heatmap days={data.data?.days ?? []} selected={onlyDay} onSelect={setOnlyDay} />
        <dl className="facts facts-row">
          <div>
            <dt>Üretilen</dt>
            <dd>{totals.produced}</dd>
          </div>
          <div>
            <dt>Paylaşılan</dt>
            <dd>{totals.shared}</dd>
          </div>
          <div>
            <dt>Silinen</dt>
            <dd>{totals.deleted}</dd>
          </div>
          <div>
            <dt>Diskte</dt>
            <dd>{bytes(totals.size)}</dd>
          </div>
        </dl>
      </section>

      <div className="toolbar panel">
        <div className="search">
          <Icon name="search" size={16} />
          <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Başlık ya da kanal ara" aria-label="Arşivde ara" />
        </div>
        <Segmented
          size="small"
          label="Tür"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'Hepsi' },
            { value: 'clip', label: 'Klipler' },
            { value: 'recording', label: 'Kayıtlar' },
            { value: 'vod', label: 'Yayınlar' },
          ]}
        />
        {onlyDay && (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setOnlyDay(null)}>
            {day(onlyDay)} <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {data.loading && !data.data ? (
        <div className="center-pad">
          <Spinner size={24} />
        </div>
      ) : !groups.length ? (
        <div className="panel">
          <Empty icon="archive" title="Bu aralıkta kayıt yok">
            Ürettiğin her klip, kayıt ve indirdiğin her yayın burada gün gün listelenir.
          </Empty>
        </div>
      ) : (
        <div className="ws-stack">
          {groups.map(([d, entries]) => (
            <section key={d} className="day-group" aria-label={day(d)}>
              <header className="day-head">
                <h2>{day(d)}</h2>
                <span className="muted">
                  {entries.length} içerik · {entries.filter((e) => e.publishStatus).length} paylaşım
                </span>
              </header>
              <ul className="ledger">
                {entries.map((e) => (
                  <LedgerRow key={e.id} entry={e} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function LedgerRow({ entry: e }: { entry: ArchiveEntry }) {
  const open = () => {
    if (e.kind === 'clip') navigate(sectionPath('galeri', e.refId));
    else if (e.kind === 'recording') navigate(sectionPath('galeri', `k${e.refId}`));
    else navigate(sectionPath('yayinlar', e.refId));
  };
  return (
    <li className={e.deletedAt ? 'ledger-row ledger-row-deleted' : 'ledger-row'}>
      <span className={e.format === 'vertical' ? 'ledger-thumb ledger-thumb-v' : 'ledger-thumb'}>
        {e.thumbUrl ? <img src={e.thumbUrl} alt="" loading="lazy" /> : <Icon name={KIND[e.kind].icon} />}
      </span>
      <div className="ledger-body">
        <b className="ledger-title">{e.title}</b>
        <span className="ledger-meta">
          <span className="tag">{KIND[e.kind].label}</span>
          {e.format && <span>{e.format === 'vertical' ? '9:16' : '16:9'}</span>}
          {e.durationSec ? <span>{duration(e.durationSec)}</span> : null}
          {e.sizeBytes ? <span>{bytes(e.sizeBytes)}</span> : null}
          {e.channelSlug && <span>{e.channelSlug}</span>}
          <span>{time(e.producedAt)}</span>
        </span>
        {e.platforms.length > 0 && (
          <span className="platform-row">
            {e.platforms.map((p) => (
              <span key={p.platform} className={`platform-chip platform-chip-${p.status}`}>
                <span className={`platform-badge platform-${p.platform}`}>{platformLabel(p.platform).slice(0, 2)}</span>
                {platformLabel(p.platform)}
              </span>
            ))}
            {e.publishedAt && <span className="muted">{dateTime(e.publishedAt)}</span>}
          </span>
        )}
      </div>
      <div className="ledger-side">
        {e.deletedAt ? (
          <span className="status status-failed">{dateTime(e.deletedAt)} silindi</span>
        ) : e.fileAvailable ? (
          <button type="button" className="btn btn-secondary btn-small" onClick={open}>
            Aç
          </button>
        ) : (
          <span className="status">Dosya yok</span>
        )}
      </div>
    </li>
  );
}

/** Son 12 haftanın günlük üretim ısı haritası (GitHub tarzı, haftalar sütun). */
function Heatmap({ days, selected, onSelect }: { days: ArchiveDay[]; selected: string | null; onSelect: (d: string | null) => void }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const max = Math.max(1, ...days.map((d) => d.produced));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Pazartesiden başlayan haftalar.
  const start = new Date(today);
  start.setDate(start.getDate() - HEAT_DAYS + 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const cells: Date[] = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) cells.push(new Date(d));

  return (
    <div className="heat" role="grid" aria-label="Günlük üretim">
      {cells.map((d) => {
        const key = dayKey(d);
        const stat = byDay.get(key);
        const level = stat ? Math.ceil((stat.produced / max) * 4) : 0;
        return (
          <button
            key={key}
            type="button"
            className={`heat-cell heat-${level}${selected === key ? ' heat-on' : ''}${stat?.shared ? ' heat-shared' : ''}`}
            title={`${day(d)}: ${stat?.produced ?? 0} üretim, ${stat?.shared ?? 0} paylaşım`}
            onClick={() => onSelect(selected === key ? null : key)}
            aria-pressed={selected === key}
          />
        );
      })}
    </div>
  );
}
