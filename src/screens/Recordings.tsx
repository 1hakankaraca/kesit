import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { CutList, Timeline, type Cut } from '../components/Timeline.tsx';
import { Empty, Field, Progress, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes, dateTime, duration } from '../lib/format.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import type { Recording, RecorderStatus, ZernioSummary } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';
import { ChannelScopeToggle } from '../components/ChannelScopeToggle.tsx';
import { useChannelScope } from '../lib/channelScope.ts';
import { takeSnapshot } from '../lib/snapshot.ts';

const STATUS: Record<Recording['status'], string> = {
  recording: 'Kayıtta',
  processing: 'Düzenleniyor',
  ready: 'Hazır',
  failed: 'Başarısız',
};

const FINAL: Record<string, string> = {
  processing: 'Hazırlanıyor',
  ready: 'Hazır',
  failed: 'Hazırlanamadı',
  cancelled: 'İptal edildi',
};

/** Kayıtlar: canlıdan alınan yayınlar ve onların işlenmesi. */
export function Recordings({ openId }: { openId: number | null }) {
  const list = useResource(() => api.get<{ recordings: Recording[]; recorder: RecorderStatus }>('/api/recordings'));
  const { inScope } = useChannelScope();
  const recordings = (list.data?.recordings ?? []).filter((r) => inScope(r.channel_slug));
  const selected = recordings.find((r) => r.id === openId) ?? recordings.find((r) => r.status === 'ready') ?? recordings[0] ?? null;

  const reload = () => void list.reload();
  useSocketEvent('recorder:finished', reload);
  useSocketEvent('recorder:edited', reload);
  useSocketEvent('recorder:publish', reload);
  useSocketEvent<{ recordingId: number; status: string; percent: number }>('recorder:final', (e) => {
    if (e.status === 'processing') list.setData((d) => d && { ...d, recordings: d.recordings.map((r) => (r.id === e.recordingId ? { ...r, final_status: 'processing', final_percent: e.percent } : r)) });
    else reload();
  });

  return (
    <>
      <WorkspaceHead guide="kayitlar" actions={<ChannelScopeToggle />} title="Yayın" tape="kayıtları" lead="Canlıdan aldığın kayıtlar. Paylaşıma hazırla, istediğin anları ayrı video yap, gereksiz kısımları at ya da YouTube'a gönder." />
      {list.loading && !list.data ? (
        <div className="center-pad">
          <Spinner size={24} />
        </div>
      ) : !recordings.length ? (
        <div className="panel">
          <Empty
            icon="record"
            title="Henüz kayıt yok"
            action={
              <button type="button" className="btn btn-accent" onClick={() => navigate(sectionPath('canli'))}>
                Canlı'ya git
              </button>
            }
          >
            Canlı yayın bölümünden kayıt başlat; durdurduğunda kayıt buraya düşer.
          </Empty>
        </div>
      ) : (
        <div className="rec-layout">
          <section className="panel panel-flat rec-list" aria-label="Kayıt listesi">
            <ul className="editor-rows">
              {recordings.map((r) => (
                <li key={r.id}>
                  <button type="button" className="clip-row" aria-current={selected?.id === r.id} onClick={() => navigate(sectionPath('kayitlar', r.id), true)}>
                    <span className="clip-row-thumb clip-row-thumb-h">
                      <Icon name="record" />
                      {r.duration_sec > 0 && <span className="clip-row-dur">{duration(r.duration_sec)}</span>}
                    </span>
                    <span className="clip-row-body">
                      <span className="clip-row-title">{r.title || `${r.channel_slug} yayını`}</span>
                      <span className="clip-row-meta">
                        <span className={`status status-${r.status === 'ready' ? 'ready' : r.status === 'failed' ? 'failed' : 'busy'}`}>{STATUS[r.status]}</span>
                        <span>{dateTime(r.started_at)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {selected && (
            <RecordingDetail
              key={selected.id}
              rec={selected}
              onChange={reload}
              onDelete={() =>
                deleteWithUndo({
                  label: 'Kayıt silindi',
                  hide: () => {
                    list.setData((d) => d && { ...d, recordings: d.recordings.filter((r) => r.id !== selected.id) });
                    navigate(sectionPath('kayitlar'), true);
                  },
                  restore: reload,
                  commit: () => api.del(`/api/recordings/${selected.id}`),
                })
              }
            />
          )}
        </div>
      )}
    </>
  );
}

function RecordingDetail({ rec, onChange, onDelete }: { rec: Recording; onChange: () => void; onDelete: () => void }) {
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [mode, setMode] = useState<'segments' | 'remove'>('segments');
  const [format, setFormat] = useState<'horizontal' | 'vertical'>('horizontal');
  const [intro, setIntro] = useState(true);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done, 'ok');
      onChange();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    mode === 'segments'
      ? run(async () => {
          await api.post(`/api/recordings/${rec.id}/segments`, {
            segments: cuts.map((c) => ({ start: c.start, end: c.end })),
            outputFormat: format,
            options: { intro, outro: intro, introAsk: false },
          });
          setCuts([]);
          await refreshJobs();
        }, `${cuts.length} kesit hazırlanıyor — Videolarım'da görünecek`)
      : run(async () => {
          await api.post(`/api/recordings/${rec.id}/edit`, { trimStart: 0, trimEnd: rec.duration_sec, cuts: cuts.map((c) => ({ start: c.start, end: c.end })), replace: false });
          setCuts([]);
        }, 'İşaretli kısımlar çıkarılarak yeni bir kopya hazırlanıyor');

  return (
    <div className="ws-stack rec-detail">
      <div className="detail-bar">
        <span className="muted">
          {rec.channel_slug} · {dateTime(rec.started_at)} · {duration(rec.duration_sec)}
        </span>
        <button type="button" className="btn btn-quiet btn-small stage-delete" onClick={onDelete} disabled={rec.status === 'recording' || rec.status === 'processing'}>
          <Icon name="trash" size={14} /> Kaydı sil
        </button>
      </div>
      <section className="panel">
        {rec.available ? (
          <Timeline src={`/api/recordings/${rec.id}/stream`} duration={rec.duration_sec} cuts={cuts} onCutsChange={setCuts} onSnapshot={(t) => void takeSnapshot('recording', rec.id, t)} />
        ) : (
          <Empty icon="record" title={rec.status === 'recording' ? 'Kayıt sürüyor' : rec.status === 'processing' ? 'Düzenleme sürüyor' : 'Kayıt dosyası yok'}>
            {rec.error || (rec.status === 'recording' ? 'Kayıt bitince burada düzenleyebilirsin.' : 'Dosya silinmiş ya da saklama süresi dolmuş olabilir.')}
          </Empty>
        )}
      </section>

      <div className="rec-panels">
        <section className="panel">
          <span className="panel-tape" aria-hidden="true" />
          <h2 className="panel-title">Kesit ve kırpma</h2>
          <Segmented
            label="İşlem"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'segments', label: 'Kesitleri ayrı üret' },
              { value: 'remove', label: 'Kayıttan çıkar' },
            ]}
          />
          <div className="pad-top">
            <CutList cuts={cuts} onChange={setCuts} />
          </div>
          {mode === 'segments' ? (
            <div className="stack pad-top">
              <Segmented
                label="Biçim"
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'horizontal', label: 'Yatay kesit' },
                  { value: 'vertical', label: 'Dikey klip' },
                ]}
              />
              {format === 'horizontal' && <Switch checked={intro} onChange={setIntro} label="Açılış ve kapanış videosu ekle" />}
            </div>
          ) : (
            <p className="field-help pad-top">İşaretlediğin kısımlar atılır, geri kalanı yeni bir kayıt olarak birleştirilir. Asıl kayıt yerinde kalır.</p>
          )}
          <button type="button" className="btn btn-accent pad-top-btn" disabled={!cuts.length || busy || !rec.available} onClick={submit}>
            {busy ? <Spinner /> : <Icon name="scissors" size={16} />}
            {mode === 'segments' ? 'Kesitleri üret' : 'Kopyayı hazırla'}
          </button>
        </section>

        <OutputPanel rec={rec} onChange={onChange} />
        <YoutubePanel rec={rec} onChange={onChange} />
      </div>
    </div>
  );
}

function OutputPanel({ rec, onChange }: { rec: Recording; onChange: () => void }) {
  const [compress, setCompress] = useState<{ profile: string; percent: number | null; ready: boolean } | null>(null);

  useSocketEvent<{ clipId: string; profil: string; percent: number }>('clipcompress:progress', (e) => {
    if (e.clipId === `rec-${rec.id}`) setCompress({ profile: e.profil, percent: e.percent, ready: false });
  });
  useSocketEvent<{ clipId: string; profil: string }>('clipcompress:done', (e) => {
    if (e.clipId === `rec-${rec.id}`) setCompress({ profile: e.profil, percent: 100, ready: true });
  });
  useSocketEvent<{ clipId: string; error: string }>('clipcompress:failed', (e) => {
    if (e.clipId === `rec-${rec.id}`) {
      setCompress(null);
      toast(e.error || 'Sıkıştırma başarısız', 'error');
    }
  });

  const finalBusy = rec.final_status === 'processing';

  return (
    <section className="panel">
      <h2 className="panel-title">Paylaşıma hazır video</h2>
      <p className="panel-sub">Kaydın açılış/kapanış videosu ve logo eklenmiş, boyutu küçültülmüş hali. Ayarları "Logo ve görünüm" bölümünde.</p>
      <dl className="facts">
        <div>
          <dt>Ham kayıt</dt>
          <dd>
            {bytes(rec.file_size)} · {rec.quality ?? '—'}
          </dd>
        </div>
        <div>
          <dt>Paylaşıma hazır</dt>
          <dd>{rec.final_status ? `${FINAL[rec.final_status] ?? rec.final_status}${rec.final_size ? ` · ${bytes(rec.final_size)}` : ''}` : 'Henüz hazırlanmadı'}</dd>
        </div>
      </dl>
      {finalBusy && <Progress value={rec.final_percent} label="Hazırlanıyor" />}
      {rec.final_error && <p className="field-error">{rec.final_error}</p>}
      <div className="row-gap pad-top">
        {finalBusy ? (
          <button type="button" className="btn btn-quiet" onClick={() => api.post(`/api/recordings/${rec.id}/final/cancel`).then(onChange, toastError)}>
            İptal
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" disabled={!rec.available} onClick={() => api.post(`/api/recordings/${rec.id}/final`).then(onChange, toastError)}>
            <Icon name="refresh" size={14} /> {rec.final_status ? 'Yeniden hazırla' : 'Paylaşıma hazırla'}
          </button>
        )}
        {rec.final_available && (
          <a className="btn btn-accent" href={`/api/recordings/${rec.id}/download?final=1`}>
            <Icon name="download" size={14} /> Hazır videoyu indir
          </a>
        )}
        {rec.available && (
          <a className="btn btn-quiet" href={`/api/recordings/${rec.id}/download`}>
            Ham kaydı indir
          </a>
        )}
      </div>
      {rec.available && (
        <div className="pad-top">
          {compress && !compress.ready ? (
            <div className="stack-s">
              <span className="muted">{compress.profile} sürüm hazırlanıyor</span>
              <Progress value={compress.percent} />
            </div>
          ) : compress?.ready ? (
            <a className="btn btn-secondary btn-small" href={`/api/recordings/${rec.id}/compress/download?profile=${compress.profile}`}>
              <Icon name="download" size={14} /> {compress.profile} sürümü indir
            </a>
          ) : (
            <div className="btn-group" role="group" aria-label="Küçültülmüş sürüm">
              {['1080p', '720p', '480p'].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="btn btn-quiet btn-small"
                  onClick={() =>
                    api.post(`/api/recordings/${rec.id}/compress`, { profile: p }).then(
                      () => setCompress({ profile: p, percent: 0, ready: false }),
                      toastError,
                    )
                  }
                >
                  {p} küçült
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const YT_STATUS: Record<string, string> = {
  uploading: 'Yükleniyor',
  draft: 'Taslak hazır',
  publishing: 'Gönderiliyor',
  published: 'YouTube\'da yayında',
  failed: 'Başarısız',
};

function YoutubePanel({ rec, onChange }: { rec: Recording; onChange: () => void }) {
  const [zernio, setZernio] = useState<ZernioSummary | null>(null);
  const [accountId, setAccountId] = useState('');
  // Form taslağa kaydedilmiş alanlardan başlar; sayfa yenilense de kaybolmaz.
  const [title, setTitle] = useState(rec.publish_title || rec.title || '');
  const [description, setDescription] = useState(rec.publish_content ?? '');
  const [visibility, setVisibility] = useState<'public' | 'unlisted' | 'private'>(rec.publish_visibility ?? 'unlisted');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<ZernioSummary>('/api/zernio')
      .then((z) => {
        setZernio(z);
        setAccountId(z.accounts.find((a) => a.platform === 'youtube')?.id ?? '');
      })
      .catch(() => {});
  }, []);

  const youtube = zernio?.accounts.filter((a) => a.platform === 'youtube') ?? [];
  const call = (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    fn()
      .then(() => {
        toast(done, 'ok');
        onChange();
      }, toastError)
      .finally(() => setBusy(false));
  };

  return (
    <section className="panel">
      <h2 className="panel-title">YouTube'a gönder</h2>
      {!zernio ? (
        <Spinner />
      ) : !zernio.connected ? (
        <button type="button" className="link" onClick={() => navigate(sectionPath('paylasim'))}>
          Zernio hesabını bağla
        </button>
      ) : !youtube.length ? (
        <p className="muted">Zernio profilinde bağlı YouTube hesabı yok.</p>
      ) : rec.publish_status && rec.publish_status !== 'failed' ? (
        <div className="stack-s">
          <p>
            <span className="status status-ready">{YT_STATUS[rec.publish_status] ?? rec.publish_status}</span>
          </p>
          {rec.publish_url && (
            <a className="link" href={rec.publish_url} target="_blank" rel="noreferrer">
              Videoyu aç
            </a>
          )}
          <div className="row-gap">
            {rec.publish_status === 'draft' && (
              <>
                <button type="button" className="btn btn-accent btn-small" disabled={busy} onClick={() => call(() => api.post(`/api/recordings/${rec.id}/youtube/send`), 'Gönderildi')}>
                  Yayınla
                </button>
                <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => call(() => api.del(`/api/recordings/${rec.id}/youtube/draft`), 'Taslak silindi')}>
                  Taslağı sil
                </button>
              </>
            )}
            <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => call(() => api.get(`/api/recordings/${rec.id}/youtube/status`), 'Durum güncellendi')}>
              Durumu yenile
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-s">
          {rec.publish_error && <p className="field-error">{rec.publish_error}</p>}
          <Field label="Hesap" htmlFor="yt-acc">
            <select id="yt-acc" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {youtube.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Başlık" htmlFor="yt-title">
            <input id="yt-title" className="input" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Açıklama" htmlFor="yt-desc">
            <textarea id="yt-desc" className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Segmented
            label="Görünürlük"
            value={visibility}
            onChange={setVisibility}
            options={[
              { value: 'unlisted', label: 'Liste dışı' },
              { value: 'private', label: 'Özel' },
              { value: 'public', label: 'Herkese açık' },
            ]}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !rec.final_available || !title.trim()}
            title={rec.final_available ? undefined : 'Önce kaydı paylaşıma hazırla'}
            onClick={() => call(() => api.post(`/api/recordings/${rec.id}/youtube/draft`, { accountId, title, content: description, visibility }), 'Taslak yükleniyor')}
          >
            <Icon name="upload" size={14} /> Taslak olarak yükle
          </button>
        </div>
      )}
    </section>
  );
}
