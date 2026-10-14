import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { parseJson } from '../lib/format.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Job, ZernioSummary } from '../lib/types.ts';
import { Icon } from './Icon.tsx';
import { Field, Modal, Segmented, Spinner, Switch } from './basics.tsx';

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  twitter: 'X',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  threads: 'Threads',
  bluesky: 'Bluesky',
};
export const platformLabel = (p: string) => PLATFORM_LABELS[p] ?? p;

/** datetime-local girişi için yerel saat biçimi. */
function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Hazır bir klibi Zernio üzerinden seçilen hesaplara hemen ya da planlı paylaşır. */
export function PublishDialog({ job, onClose, onDone }: { job: Job | null; onClose: () => void; onDone: () => void }) {
  const [zernio, setZernio] = useState<ZernioSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [when, setWhen] = useState(() => localInput(new Date(Date.now() + 60 * 60_000)));
  const [privacy, setPrivacy] = useState('PUBLIC_TO_EVERYONE');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!job) return;
    const tags = parseJson<string[]>(job.gen_hashtags, []);
    setContent([job.gen_description || job.gen_title || job.title || '', tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n'));
    setSelected(new Set());
    setConsent(false);
    setZernio(null);
    api.get<ZernioSummary>('/api/zernio').then(setZernio).catch(toastError);
  }, [job]);

  const accounts = zernio?.accounts ?? [];
  const chosen = useMemo(() => accounts.filter((a) => selected.has(`${a.platform}:${a.id}`)), [accounts, selected]);
  const hasTikTok = chosen.some((a) => a.platform === 'tiktok');

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const submit = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const res = await api.post<{ publishStatus: string; scheduled: boolean; publishedImmediately: boolean }>(`/api/jobs/${job.id}/publish`, {
        accounts: chosen.map((a) => ({ platform: a.platform, accountId: a.id })),
        content,
        scheduledFor: mode === 'later' ? new Date(when).toISOString() : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tiktokSettings: hasTikTok ? { privacy_level: privacy, allow_comment: true, allow_duet: false, allow_stitch: false, content_preview_confirmed: consent, express_consent_given: consent } : undefined,
      });
      toast(res.scheduled ? 'Paylaşım planlandı' : res.publishedImmediately ? 'Plan anı geçtiği için hemen paylaşıldı' : 'Paylaşım gönderildi', 'ok');
      onDone();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.body.fileTooLarge) toast('Dosya Zernio sınırını aşıyor — indirip elle yükleyebilirsin', 'error');
      else toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!job}
      onClose={onClose}
      title="Klibi paylaş"
      footer={
        zernio?.connected && (
          <>
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              Vazgeç
            </button>
            <button type="button" className="btn btn-accent" disabled={busy || !chosen.length || (hasTikTok && !consent)} onClick={submit}>
              {busy ? <Spinner /> : <Icon name={mode === 'later' ? 'calendar' : 'share'} size={16} />}
              {mode === 'later' ? 'Planla' : 'Şimdi paylaş'}
            </button>
          </>
        )
      }
    >
      {!zernio ? (
        <div className="center-pad">
          <Spinner size={22} />
        </div>
      ) : !zernio.connected ? (
        <div className="stack">
          <p className="notice">Paylaşım için önce Zernio hesabını bağlaman gerekiyor. Sosyal hesaplarını Zernio panelinde bağlarsın; Kesit onları buradan kullanır.</p>
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => {
              onClose();
              navigate(sectionPath('paylasim'));
            }}
          >
            <Icon name="key" size={16} /> Zernio'yu bağla
          </button>
        </div>
      ) : (
        <div className="stack">
          <Field label="Hesaplar" help={accounts.length ? undefined : 'Zernio profilinde bağlı sosyal hesap yok.'}>
            <div className="account-grid">
              {accounts.map((a) => {
                const key = `${a.platform}:${a.id}`;
                return (
                  <label key={key} className={selected.has(key) ? 'account account-on' : 'account'}>
                    <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                    <span className={`platform-badge platform-${a.platform}`}>{platformLabel(a.platform).slice(0, 2)}</span>
                    <span>
                      <b>{a.displayName}</b>
                      <small>{platformLabel(a.platform)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </Field>
          <Field label="Açıklama" help="İlk satır YouTube başlığı olarak kullanılır." htmlFor="pub-content">
            <textarea id="pub-content" className="textarea" rows={5} maxLength={2000} value={content} onChange={(e) => setContent(e.target.value)} />
          </Field>
          <Segmented
            label="Zaman"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'now', label: 'Hemen' },
              { value: 'later', label: 'Planla' },
            ]}
          />
          {mode === 'later' && <input type="datetime-local" className="input" value={when} min={localInput(new Date(Date.now() + 6 * 60_000))} onChange={(e) => setWhen(e.target.value)} aria-label="Paylaşım zamanı" />}
          {hasTikTok && (
            <div className="subtle-box stack-s">
              <Field label="TikTok gizliliği" htmlFor="tt-privacy">
                <select id="tt-privacy" className="input" value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
                  <option value="PUBLIC_TO_EVERYONE">Herkese açık</option>
                  <option value="MUTUAL_FOLLOW_FRIENDS">Karşılıklı takipleşenler</option>
                  <option value="FOLLOWER_OF_CREATOR">Takipçiler</option>
                  <option value="SELF_ONLY">Yalnız ben</option>
                </select>
              </Field>
              <Switch checked={consent} onChange={setConsent} label="Videoyu önizledim, yayınlanmasını onaylıyorum" hint="TikTok her gönderide açık onay ister." />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
