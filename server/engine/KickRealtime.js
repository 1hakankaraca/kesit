/**
 * KickRealtime — Kick chat'inin yeni gerçek zamanlı altyapısına bağlanır.
 *
 * Kick 2026 sonbaharında chat'i Pusher'dan kendi Centrifugo sunucusuna taşıdı;
 * eski "32cbd69e…" Pusher anahtarı artık hiçbir kümede yok ("App key not in
 * this cluster"). Bağlantı bilgisi artık dinamik alınır:
 *
 *  1. POST web.kick.com/api/v1/realtime/channels/{channelId}/chat/connection
 *     → { connections: [{ provider: 'centrifugo', credentials: { url } }] }
 *  2. POST web.kick.com/api/v1/realtime/auth/connection { client_id }
 *     → { token } (misafir JWT, ~45 dk)
 *  3. wss://… Centrifugo JSON protokolü: {id,connect:{token}} →
 *     {id,subscribe:{channel:'chatrooms.<chatroomId>.v2'}} → push.pub.data
 *     = { event: 'App\\Events\\ChatMessageEvent', data: <nesne|JSON metni> }
 *  4. Sunucu boş `{}` ping'i yollar; aynı `{}` ile pong dönülür.
 *
 * Token süresi dolunca sunucu bağlantıyı 109 koduyla kapatır; yeniden
 * bağlanırken token tazelenir. Bağlantı koparsa üstel bekleme ile tekrar denenir.
 */
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const WEB_API = 'https://web.kick.com/api';
const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Referer': 'https://kick.com',
    'x-app-platform': 'web',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};
const PROVIDERS = { accepted_providers: [{ provider: 'centrifugo' }] };
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
const FETCH_TIMEOUT_MS = 10000;

async function postJson(path, body) {
    const res = await fetch(`${WEB_API}${path}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Kick realtime ${path} → HTTP ${res.status}`);
    return res.json();
}

/** Chat yayınının Centrifugo adresi (kanala göre değişebilir). */
async function fetchChatEndpoint(channelId, clientId) {
    const json = await postJson(`/v1/realtime/channels/${channelId}/chat/connection`, { client: { id: clientId, type: 'web' }, capabilities: PROVIDERS });
    const conn = (json?.data?.connections || []).find((c) => c.provider === 'centrifugo' && c.credentials?.url);
    if (json?.data?.mode !== 'websocket' || !conn) throw new Error('Kick realtime: Centrifugo bağlantısı sunulmadı');
    return conn.credentials.url;
}

/** Misafir bağlantı token'ı. */
async function fetchConnectionToken(clientId) {
    const json = await postJson('/v1/realtime/auth/connection', { client_id: clientId });
    const token = json?.data?.token;
    if (!token) throw new Error('Kick realtime: bağlantı token\'ı alınamadı');
    return token;
}

/** Yayın zarfı: { event, data } — data çoğu zaman JSON metni olarak gelir. */
function parseEnvelope(pub) {
    const env = pub?.data;
    if (!env || typeof env.event !== 'string') return null;
    let data = env.data;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { /* düz metin kalsın */ }
    }
    return { event: env.event, data };
}

class KickRealtime {
    /**
     * @param {object} o
     * @param {number} o.channelId  kick.com/api/v2/channels/<slug> → id
     * @param {string[]} o.channels  abone olunacak kanallar (ör. chatrooms.<id>.v2)
     * @param {(event: string, data: any, channel: string) => void} o.onEvent
     * @param {(connected: boolean) => void} [o.onState]
     * @param {(msg: string, err?: Error) => void} [o.log]
     */
    constructor({ channelId, channels, onEvent, onState, log }) {
        this.channelId = channelId;
        this.channels = channels;
        this.onEvent = onEvent;
        this.onState = onState || (() => {});
        this.log = log || (() => {});
        this.clientId = randomUUID();
        this.ws = null;
        this.connected = false;
        this.stopped = true;
        this._attempt = 0;
        this._retry = null;
        this._nextId = 1;
    }

    start() {
        this.stopped = false;
        void this._connect();
    }

    stop() {
        this.stopped = true;
        if (this._retry) { clearTimeout(this._retry); this._retry = null; }
        this._closeSocket();
        this._setConnected(false);
    }

    _setConnected(v) {
        if (this.connected === v) return;
        this.connected = v;
        this.onState(v);
    }

    _closeSocket() {
        const ws = this.ws;
        this.ws = null;
        if (!ws) return;
        ws.removeAllListeners();
        try { ws.close(); } catch { /* yok say */ }
    }

    _scheduleRetry(reason) {
        if (this.stopped || this._retry) return;
        const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this._attempt++);
        this.log(`yeniden bağlanılacak (${Math.round(delay / 1000)} sn): ${reason}`);
        this._retry = setTimeout(() => { this._retry = null; void this._connect(); }, delay);
        this._retry.unref?.();
    }

    async _connect() {
        if (this.stopped) return;
        let url;
        let token;
        try {
            [url, token] = await Promise.all([fetchChatEndpoint(this.channelId, this.clientId), fetchConnectionToken(this.clientId)]);
        } catch (err) {
            return this._scheduleRetry(err.message);
        }
        if (this.stopped) return;

        const ws = new WebSocket(url, { headers: { 'User-Agent': HEADERS['User-Agent'], Origin: 'https://kick.com' } });
        this.ws = ws;
        const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

        ws.on('open', () => {
            this._nextId = 1;
            send({ id: this._nextId++, connect: { token, name: 'js' } });
        });
        ws.on('message', (raw) => {
            const text = String(raw);
            // Centrifugo birden çok çerçeveyi satırla ayırarak yollayabilir.
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (!t) continue;
                if (t === '{}') { send({}); continue; } // ping → pong
                let msg;
                try { msg = JSON.parse(t); } catch { continue; }
                this._handle(msg, send);
            }
        });
        ws.on('close', (code, reason) => {
            if (this.ws !== ws) return;
            this.ws = null;
            this._setConnected(false);
            this._scheduleRetry(`bağlantı kapandı (${code} ${String(reason || '')})`.trim());
        });
        ws.on('error', (err) => {
            if (this.ws !== ws) return;
            this.log('websocket hatası', err);
            // 'close' ardından gelir; yeniden deneme orada planlanır.
        });
    }

    _handle(msg, send) {
        if (msg.error) {
            this.log(`sunucu hatası: ${msg.error.code} ${msg.error.message || ''}`);
            return;
        }
        if (msg.connect) {
            this._attempt = 0;
            this._setConnected(true);
            for (const channel of this.channels) send({ id: this._nextId++, subscribe: { channel } });
            return;
        }
        if (msg.disconnect) {
            this.log(`sunucu bağlantıyı kapattı: ${msg.disconnect.code} ${msg.disconnect.reason || ''}`);
            return; // 'close' olayı yeniden bağlanmayı planlar
        }
        const push = msg.push;
        if (!push || !push.pub) return;
        const env = parseEnvelope(push.pub);
        if (!env) return;
        try {
            this.onEvent(env.event, env.data, push.channel);
        } catch (err) {
            this.log('olay işlenemedi', err);
        }
    }
}

module.exports = { KickRealtime, parseEnvelope, fetchChatEndpoint, fetchConnectionToken };
