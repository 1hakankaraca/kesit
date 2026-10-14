# Kesit

Kick yayıncıları için klip stüdyosu. Kurulduğu bilgisayarda çalışır; bütün veriler o bilgisayarda kalır. Kick hesabıyla ya da misafir olarak girilir; açılışta editör düzeninde bir kütüphane karşılar. Her sayfada "Nasıl kullanılır" rehberi vardır ve ilk ziyarette kendiliğinden açılır.

- **Klipler**: Kanalın Kick/KickBot kliplerini tara, seç, toplu olarak dikey videoya çevir. Yüz kamerası tespiti, altyazı ve 9:16 kompozisyon otomatik yapılır. Klip bağlantısı yapıştırarak da eklenebilir.
- **Geçmiş yayınlar**: Kick'in sakladığı yayını indir. Zaman çizelgesinde sürükleyerek ya da I/O ile kesit işaretle, en iyi anları otomatik buldur.
- **Kanal sekmeleri**: Üst ortada Kick'te arayarak kanal seçilir; her yayıncı bir sekme olur, "+" yeni sekme açar. Etkin sekme tarama, kayıt ve nöbetin varsayılanıdır.
- **Canlı**: Elle yayın kaydı (geçmişten başlatılabilir), canlı önizleme ve chat'e düşen klipleri yakalayıp otomatik işleme.
- **Nöbet**: Takip edilen kanalı sunucu tarafında yoklar. Yayın açılınca kaydı ve klip yakalamayı başlatır. Yayın bitince kaydı kapatır; intro, outro ve logo eklenmiş çıktı kendiliğinden üretilir. Tarayıcı kapalıyken de çalışır, sunucu yeniden başlarsa geri kurulur.
- **Kayıtlar**: Yayına hazır çıktı, kesitleri ayrı klip/kesit olarak üretme, istenmeyen kısımları çıkarma, küçültülmüş indirme, Zernio ile YouTube'a taslak → yayın.
- **Paylaşım**: Her kullanıcı kendi Zernio API anahtarını bağlar. Anahtar veritabanında AES-GCM ile şifreli durur. Hemen ya da planlı paylaşım yapılabilir; TikTok için açık onay zorunludur.
- **Arşiv**: Üretilen her klip, kayıt ve indirilen yayın günlük bir defterde tutulur. Dosya silinse bile kayıt, küçük görsel ve paylaşım geçmişi kalır. Isı haritasından güne göre süzülebilir.
- **Ayarlar**: Altyazı motoru (bu bilgisayarda çalışan ücretsiz whisper modeli tek tıkla indirilir ya da ElevenLabs anahtarı bağlanır), telefondan açma adresi ve verilerin bulunduğu klasör.
- **Marka ve şablon**: Logo, intro, outro, marka/vurgu rengi ve altyazı stili ayarlanır. Dikey ve yatay prototipte yerleşim önizlenir; yatayda logo sürüklenerek konumlanır. Kaynağa göre üretim varsayılanları ve kayıt çıktısı ayarları da buradadır.

## Çalıştırma

Gerekenler: Node 22.5+ (yerleşik `node:sqlite`) ve `ffmpeg`/`ffprobe`. Yerel altyazı için `whisper-cli` (`brew install whisper-cpp`); model Ayarlar sayfasından indirilir.

```sh
npm install
npm run dev            # arayüz http://localhost:5174, API 3002
```

`.env` gerekmez. "Kick ile giriş" Kick'te kanal arayıp hesabı bağlar; Kesit Kick'e hiçbir şey yazmadığı için geliştirici uygulaması gerekmez. İstenirse `.env`'e `KICK_CLIENT_ID/SECRET` yazılarak resmi OAuth girişi açılabilir. Aynı Wi-Fi'daki telefondan açma adresi uygulamanın sol alt köşesinde ve Ayarlar'da yazar.

Yayın için tek süreç yeterlidir. Sunucu derlenmiş arayüzü de kendisi sunar:

```sh
npm run build
npm start
```

Docker ile çalıştırırken `/data` kalıcı bir diske bağlanmalıdır. Veritabanı, klipler, kayıtlar ve arşiv görselleri orada durur:

```sh
docker build -t kesit .
docker run -p 3002:3002 -v kesit-data:/data --env-file .env kesit
```

Kalıcı süreç ve disk gerektiğinden Railway, Fly.io, Render ya da kendi sunucun uygundur. Sunucusuz ortamlar uygun değildir.

## Komutlar

| Komut | İşi |
|---|---|
| `npm run dev` | Sunucu ve arayüzü izleme modunda başlatır |
| `npm test` | Veri katmanı, arşiv defteri, kompozisyon planı, kuyruk ve nöbet ayarı testleri |
| `npm run build` | Tip denetimi ve üretim derlemesi |

## Yapı

```
server/index.ts         HTTP, korumalı /clips dosya servisi, socket.io, açılış/kapanış
server/auth.ts          Kick OAuth (PKCE), misafir girişi, imzalı çerez oturumları
server/db/              SQLite şeması ve Store (motorun beklediği veri metotları)
server/services/        Workspaces (kullanıcı başına motor), Autopilot (Nöbetçi),
                        Publishing (Zernio), ArchiveLedger (arşiv defteri)
server/routes/          Alan başına API uçları
server/engine/          Klip motoru (LivoBot'tan taşındı, CommonJS)
shared/                 İstemci ve sunucunun ortak tipleri
src/                    React arayüzü (screens, components, lib, styles)
```

### Klip motoru

`server/engine` LivoBot'un klip editörü modülüdür. Kesit'e taşınırken yapılan değişiklikler:

- **Outro**: `HorizontalComposer`, `RecordingFinalizer` ve `ClipEditorManager` intro'ya ek olarak outro da ekler. `IntroStore` iki türü birlikte yönetir.
- **Zernio**: `ZernioPublisher` artık kullanıcı başına API anahtarı alıyor. Profil listesi `listProfiles` ile çekilir.
- **Kuyruk**: `VodScanManager` Redis yoksa süreç içi kuyruğa (`LocalQueue`) düşer.
- **Önizleme**: Canlı önizleme adresi `/api/live/preview` yoluna taşındı.
- **Altyazı**: `Transcriber` whisper ikilisini ve modelini çalışma anında okur (model Ayarlar'dan indirilebilsin diye).
- **Otomatik başlık/açıklama**: `ClipEditorManager` içinde `AUTO_METADATA = false` ile kapalı.

Motor `server/engine.ts` üzerinden içe aktarılır. Bu dosya ortam yapılandırmasının motordan önce yüklenmesini sağlar.

## Güvenlik notları

- Kick hesabı kanal adıyla bağlanır (ya da OAuth tanımlıysa yalnız `user:read channel:read` izniyle). Erişim belirteci saklanmaz.
- Zernio ve ElevenLabs anahtarları AES-GCM ile şifreli, yalnız bu bilgisayarda tutulur.
- Üretilen dosyalar `/clips/<kullanıcı>/...` altında sunulur ve yalnız sahibine açıktır.
- Durum değiştiren isteklerde köken denetimi yapılır ve çerezler `SameSite=Lax` ile gönderilir.
- Misafir hesabı tarayıcıdaki oturum çerezine bağlıdır. Sonradan Kick ile giriş yapılırsa misafirin işleri taşınmaz.
