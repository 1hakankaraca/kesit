/**
 * LocalQueue — BullMQ'nun VodScanManager'ın kullandığı küçük alt kümesinin
 * süreç içi (bellek) karşılığı. REDIS_URL tanımlı değilken tek sunuculu
 * kurulumlar VOD taramasını Redis'siz çalıştırabilsin diye vardır.
 *
 * Sınırlar bilinçlidir: kuyruk süreç ömrü kadar yaşar (yeniden başlatmada
 * bekleyen işler kaybolur — VodScanManager.reconcile bunları zaten 'failed'
 * yapar) ve otomatik yeniden deneme yoktur (VodScanManager attempts:1 kullanır).
 */
const { EventEmitter } = require('events');

/** Kuyruk adı → { bekleyenler, worker } — Queue ile Worker aynı ad üzerinden buluşur. */
const kanallar = new Map();

function kanal(ad) {
    if (!kanallar.has(ad)) kanallar.set(ad, { bekleyenler: [], worker: null });
    return kanallar.get(ad);
}

let sonrakiId = 1;

class Queue {
    constructor(ad) {
        this.ad = ad;
    }

    async add(isAdi, data) {
        const k = kanal(this.ad);
        const job = {
            id: String(sonrakiId++),
            name: isAdi,
            data,
            remove: async () => {
                const i = k.bekleyenler.indexOf(job);
                if (i === -1) throw new Error('İş artık kuyrukta değil');
                k.bekleyenler.splice(i, 1);
            },
        };
        k.bekleyenler.push(job);
        k.worker?._bosalt();
        return job;
    }

    async close() { /* bellek kuyruğu — kapatılacak bağlantı yok */ }
}

class Worker extends EventEmitter {
    constructor(ad, isleyici, { concurrency = 1 } = {}) {
        super();
        this.ad = ad;
        this.isleyici = isleyici;
        this.esZamanli = Math.max(1, concurrency);
        this.calisan = 0;
        this.kapali = false;
        kanal(ad).worker = this;
        this._bosalt();
    }

    _bosalt() {
        const k = kanal(this.ad);
        while (!this.kapali && this.calisan < this.esZamanli && k.bekleyenler.length) {
            const job = k.bekleyenler.shift();
            this.calisan++;
            Promise.resolve()
                .then(() => this.isleyici(job))
                .then(() => this.emit('completed', job))
                .catch(err => this.emit('failed', job, err))
                .finally(() => {
                    this.calisan--;
                    this._bosalt();
                });
        }
    }

    async close() {
        this.kapali = true;
        const k = kanal(this.ad);
        if (k.worker === this) k.worker = null;
    }
}

module.exports = { Queue, Worker };
