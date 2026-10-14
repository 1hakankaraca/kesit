# Kesit

Kick yayıncıları için klip stüdyosu. Kurulduğu bilgisayarda çalışır; bütün veriler o bilgisayarda kalır. Kick hesabıyla ya da misafir olarak girilir; açılışta editör düzeninde bir kütüphane karşılar. Her sayfada "Nasıl kullanılır" rehberi vardır ve ilk ziyarette kendiliğinden açılır.

- **Klipler**: Kanalın Kick/KickBot kliplerini tara, seç, toplu olarak dikey videoya çevir. Yüz kamerası tespiti, altyazı ve 9:16 kompozisyon otomatik yapılır. Klip bağlantısı yapıştırarak da eklenebilir.
- **Geçmiş yayınlar**: Kick'in sakladığı yayını indir. Zaman çizelgesinde sürükleyerek ya da I/O ile kesit işaretle, en iyi anları otomatik buldur.
- **Kanal sekmeleri**: Üst ortada Kick'te arayarak kanal seçilir; her yayıncı bir sekme olur, "+" yeni sekme açar. Etkin sekme tarama, kayıt ve nöbetin varsayılanıdır.
- **Canlı**: Elle yayın kaydı (geçmişten başlatılabilir), canlı önizleme, chat'e düşen klipleri yakalayıp otomatik işleme, sohbete `!clip 30…180` gönderen anlık klip düğmeleri (kanalda klip botu varsa çalışır; Kick ile giriş gerekir) ve kanala eklenen yeni Kick kliplerini arka planda indiren klip takibi.
- **Nöbet**: Takip edilen kanalı sunucu tarafında yoklar. Yayın açılınca chat klip yakalamayı başlatır; yayın bitince Kick'in yayın kaydını indirir ve Geçmiş yayınlar'a koyar — hiçbir şey otomatik işlenmez, editörde sen kesersin. Tarayıcı kapalıyken de çalışır, sunucu yeniden başlarsa geri kurulur.
- **Kayıtlar**: Yayına hazır çıktı, kesitleri ayrı klip/kesit olarak üretme, istenmeyen kısımları çıkarma, küçültülmüş indirme, Zernio ile YouTube'a taslak → yayın.
- **Paylaşım**: Her kullanıcı kendi Zernio API anahtarını bağlar. Anahtar veritabanında AES-GCM ile şifreli durur. Hemen ya da planlı paylaşım yapılabilir; TikTok için açık onay zorunludur.
- **Arşiv**: Üretilen her klip, kayıt ve indirilen yayın günlük bir defterde tutulur. Dosya silinse bile kayıt, küçük görsel ve paylaşım geçmişi kalır. Isı haritasından güne göre süzülebilir.
- **Ayarlar**: Altyazı motoru (önerilen yerel whisper modeli tek tıkla indirilir ya da ElevenLabs anahtarı bağlanır), hazır videoların kopyalanacağı klasör (varsayılan `~/Downloads/Kesit`, Dikey/Yatay/Kayıtlar), disk kullanımı ve önbellek/video temizliği, telefondan açma adresi.
- **Silme**: Hiçbir silme onay sormaz; bildirimdeki "Geri al" ile 6 saniye içinde geri alınır.
- **Marka ve şablon**: Logo, marka/vurgu rengi ve altyazı stili. Üretim varsayılanları Dikey ve Yatay olarak ayrıdır; prototip seçili biçimi gösterir (yatayda logo sürüklenir). Intro/outro yalnız yatay videolara eklenir. Çıktı ayarları Kayıtlar'daki "Çıktıyı üret" içindir; hiçbir çıktı kendiliğinden üretilmez.

## Çalıştırma

Gerekenler: Node 22.5+ (yerleşik `node:sqlite`) ve `ffmpeg`/`ffprobe`. Yerel altyazı için `whisper-cli` (`brew install whisper-cpp`); model Ayarlar sayfasından indirilir.

```sh
npm install
npm run dev            # arayüz http://localhost:5174, API 3002
```

"Kick ile giriş" Kick'te kanalı arayıp hesabı bağlar; anahtar ya da `.env` gerekmez. Sohbete klip atma (anlık klip) için her kullanıcı Ayarlar'da kendi Kick geliştirici uygulamasını kurar: Kick'te uygulama oluşturur, Ayarlar'da gösterilen dönüş adresini (ör. `http://localhost:3002/auth/kick/callback`) kaydeder, Client ID ve Secret'ı girer ve "Kick hesabını bağla" der. Anahtarlar şifreli olarak yalnız o bilgisayarda durur; Kesit hiçbir sunucuya bağlı değildir. Aynı Wi-Fi'daki telefondan açma adresi uygulamanın sol alt köşesinde ve Ayarlar'da yazar.

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

- Kick hesabı kanal adıyla bağlanır. Sohbete yazma için kullanıcının kendi Kick uygulamasıyla alınan belirteç şifreli saklanır ve otomatik yenilenir; dönüş yalnız `localhost`/yerel ağ adreslerine yapılır.
- Zernio, ElevenLabs ve Kick uygulaması anahtarları AES-GCM ile şifreli, yalnız bu bilgisayarda tutulur.
- Üretilen dosyalar `/clips/<kullanıcı>/...` altında sunulur ve yalnız sahibine açıktır.
- Durum değiştiren isteklerde köken denetimi yapılır ve çerezler `SameSite=Lax` ile gönderilir.
- Misafir hesabı tarayıcıdaki oturum çerezine bağlıdır. Sonradan Kick ile giriş yapılırsa misafirin işleri taşınmaz.
