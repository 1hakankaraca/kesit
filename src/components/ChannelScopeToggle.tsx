import { setShowAllChannels, useChannelScope } from '../lib/channelScope.ts';
import { Segmented } from './basics.tsx';

/** "Sadece <kanal> / Tüm kanallar" seçimi — listeler etkin kanal sekmesine göre süzülür. */
export function ChannelScopeToggle() {
  const { channel, showAll } = useChannelScope();
  if (!channel) return null;
  return (
    <Segmented
      size="small"
      label="Hangi kanal"
      value={showAll ? 'all' : 'one'}
      onChange={(v) => setShowAllChannels(v === 'all')}
      options={[
        { value: 'one', label: `Sadece ${channel}` },
        { value: 'all', label: 'Tüm kanallar' },
      ]}
    />
  );
}
