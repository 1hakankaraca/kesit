import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { api, query } from '../lib/api.ts';
import { count } from '../lib/format.ts';
import { Icon } from './Icon.tsx';
import { Spinner } from './basics.tsx';

export interface ChannelHit {
  slug: string;
  username: string;
  avatarUrl: string | null;
  followers: number;
  isLive: boolean;
  verified: boolean;
}

/**
 * Kick kanal arayıcı: yazdıkça Kick'te arar, sonuçları açılır listede
 * gösterir. Klavye ile gezilir (↑ ↓ Enter, Esc kapatır).
 */
export function ChannelSearch({
  onPick,
  placeholder = 'Kick kanalı ara',
  autoFocus = false,
  large = false,
}: {
  onPick: (hit: ChannelHit) => void;
  placeholder?: string;
  autoFocus?: boolean;
  large?: boolean;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ChannelHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .get<{ channels: ChannelHit[] }>(`/api/kick/search${query({ q: term })}`)
        .then((r) => {
          if (mine !== seq.current) return;
          setHits(r.channels);
          setCursor(0);
          setOpen(true);
        })
        .catch(() => mine === seq.current && setHits([]))
        .finally(() => mine === seq.current && setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const pick = (hit: ChannelHit) => {
    onPick(hit);
    setQ('');
    setHits([]);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(hits.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter' && hits[cursor]) {
      e.preventDefault();
      pick(hits[cursor]);
    } else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className={large ? 'csearch csearch-large' : 'csearch'}>
      <div className="search">
        <Icon name="search" size={16} />
        <input
          className="search-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => hits.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-expanded={open}
          aria-controls={listId}
          role="combobox"
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
        />
        {loading && <Spinner size={14} />}
      </div>
      <AnimatePresence>
        {open && q.trim().length >= 2 && (
          <motion.ul id={listId} role="listbox" className="csearch-list" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
            {hits.length === 0 && !loading && <li className="csearch-empty">Kanal bulunamadı</li>}
            {hits.map((h, i) => (
              <li key={h.slug} role="option" aria-selected={i === cursor}>
                <button type="button" className="csearch-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)} onMouseEnter={() => setCursor(i)}>
                  {h.avatarUrl ? <img src={h.avatarUrl} alt="" /> : <span className="csearch-avatar" />}
                  <span className="csearch-name">
                    <b>{h.username}</b>
                    <small>
                      {count(h.followers)} takipçi{h.verified ? ' · doğrulanmış' : ''}
                    </small>
                  </span>
                  {h.isLive && <span className="csearch-live">CANLI</span>}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
