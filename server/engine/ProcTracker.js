/**
 * ProcTracker — bir işin başlattığı alt süreçleri (ffmpeg, ffprobe, whisper)
 * iş anahtarına göre izler; iş iptal edilince hepsini öldürür.
 *
 * Motor modülleri `child_process` yerine buradaki `spawn`/`execFile`'ı
 * kullanır (aynı imza). Çağrı bir `run(key, fn)` bağlamı içindeyse açılan
 * süreç o anahtara yazılır; bağlam yoksa (ör. kayıt, sıkıştırma) düz
 * child_process davranışı — ek maliyet yok.
 */
const childProcess = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
/** @type {Map<string, Set<import('child_process').ChildProcess>>} */
const active = new Map();

function remember(proc) {
    const key = als.getStore();
    if (!key || !proc) return proc;
    let set = active.get(key);
    if (!set) {
        set = new Set();
        active.set(key, set);
    }
    set.add(proc);
    const forget = () => {
        set.delete(proc);
        if (set.size === 0 && active.get(key) === set) active.delete(key);
    };
    proc.once('exit', forget);
    proc.once('error', forget);
    return proc;
}

/** `fn` içinde (ve onun beklediği her async zincirde) açılan süreçler `key`'e yazılır. */
function run(key, fn) {
    return als.run(key, fn);
}

/** Anahtara bağlı tüm süreçleri öldürür; kaç süreç öldürüldüğünü döner. */
function kill(key, signal = 'SIGKILL') {
    const set = active.get(key);
    if (!set) return 0;
    let n = 0;
    for (const proc of set) {
        try {
            if (proc.exitCode === null && !proc.killed) {
                proc.kill(signal);
                n++;
            }
        } catch { /* zaten bitmiş */ }
    }
    return n;
}

function spawn(...args) {
    return remember(childProcess.spawn(...args));
}

function execFile(...args) {
    return remember(childProcess.execFile(...args));
}

module.exports = { run, kill, spawn, execFile, current: () => als.getStore() };
