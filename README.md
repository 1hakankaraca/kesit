# Kesit

Kick yayıncıları için klip stüdyosu. Kurulduğu bilgisayarda çalışır; bütün veriler o bilgisayarda kalır, hiçbir sunucuya bağlı değildir. Kick hesabıyla ya da misafir olarak girilir; açılışta editör düzeninde bir kütüphane karşılar. Her sayfada "Nasıl kullanılır" rehberi vardır ve ilk ziyarette kendiliğinden açılır.

- **Klipler**: Kanalın Kick/KickBot kliplerini tara, seç, toplu olarak dikey videoya çevir. Yüz kamerası tespiti, altyazı ve 9:16 kompozisyon otomatik yapılır. Klip bağlantısı yapıştırarak da eklenebilir.
- **Geçmiş yayınlar**: Kick'in sakladığı yayını indir. Zaman çizelgesinde sürükleyerek ya da I/O ile kesit işaretle, en iyi anları otomatik buldur.
- **Kanal sekmeleri**: Üst ortada Kick'te arayarak kanal seçilir; her yayıncı bir sekme olur, "+" yeni sekme açar. Etkin sekme tarama, kayıt ve nöbetin varsayılanıdır.
- **Canlı**: Elle yayın kaydı (geçmişten başlatılabilir), canlı önizleme, chat'e düşen klipleri yakalayıp otomatik işleme, sohbete `!clip 30…180` gönderen anlık klip düğmeleri (kanalda klip botu varsa çalışır; Ayarlar'da kendi Kick uygulamanı bağlaman gerekir) ve kanala eklenen yeni Kick kliplerini arka planda indiren klip takibi.
- **Nöbet**: Takip edilen kanalı arka planda yoklar. Yayın açılınca chat klip yakalamayı başlatır; yayın bitince Kick'in yayın kaydını indirir ve Geçmiş yayınlar'a koyar — hiçbir şey otomatik işlenmez, editörde sen kesersin. Tarayıcı kapalıyken de çalışır (Kesit açık ve bilgisayar uyanık olmalı); yeniden başlatmada geri kurulur.
- **Kayıtlar**: Yayına hazır çıktı, kesitleri ayrı klip/kesit olarak üretme, istenmeyen kısımları çıkarma, küçültülmüş indirme, Zernio ile YouTube'a taslak → yayın.
- **Paylaşım**: Her kullanıcı kendi Zernio API anahtarını bağlar. Anahtar veritabanında AES-GCM ile şifreli durur. Hemen ya da planlı paylaşım yapılabilir; TikTok için açık onay zorunludur.
- **Arşiv**: Üretilen her klip, kayıt ve indirilen yayın günlük bir defterde tutulur. Dosya silinse bile kayıt, küçük görsel ve paylaşım geçmişi kalır. Isı haritasından güne göre süzülebilir.
- **Ayarlar**: Kendi Kick uygulamanı bağlama (sohbete klip atma), altyazı motoru (önerilen yerel whisper modeli tek tıkla indirilir ya da ElevenLabs anahtarı bağlanır), hazır videoların kopyalanacağı klasör (varsayılan `~/Downloads/Kesit`, Dikey/Yatay/Kayıtlar), disk kullanımı ve önbellek/video temizliği, telefondan erişim (eşleme koduyla).
- **Silme**: Hiçbir silme onay sormaz; bildirimdeki "Geri al" ile 6 saniye içinde geri alınır.
- **Marka ve şablon**: Logo, marka/vurgu rengi ve altyazı stili. Üretim varsayılanları Dikey ve Yatay olarak ayrıdır; önizleme motorun gerçek oranlarıyla çizilir. Logo sürüklenir; merkeze, üçte birlere ve güvenli kenarlara yapışır, 3x3 hizalama vardır. Yatayda altyazı varsayılan kapalıdır. Intro/outro yalnız yatay videolara eklenir. Çıktı ayarları Kayıtlar'daki "Çıktıyı üret" içindir; hiçbir çıktı kendiliğinden üretilmez.

## Çalıştırma

Gerekenler: Node 22.5+ (yerleşik `node:sqlite`) ve `ffmpeg`/`ffprobe`. Yerel altyazı için `whisper-cli` (`brew install whisper-cpp`); model Ayarlar sayfasından indirilir.

```sh
npm install
npm run dev            # arayüz http://localhost:5174, API 3002
```

Günlük kullanım için derleyip tek süreçle çalıştır (arayüz ve API aynı adreste, http://localhost:3002):

```sh
npm run build
npm start
```

`.env` gerekmez. İlk açılışta `data/.secret` dosyasına bu kuruluma özel rastgele bir anahtar yazılır; çerezler ve saklanan anahtarlar (Zernio, ElevenLabs, Kick) bununla şifrelenir. Bu dosya silinirse kayıtlı anahtarlar yeniden girilmelidir.

### Kick

"Kick ile giriş" Kick'te kanalı arayıp hesabı bağlar; şifre ya da anahtar gerekmez. Sohbete klip atma (anlık klip) için her kullanıcı Ayarlar'da kendi Kick geliştirici uygulamasını kurar: Kick'te uygulama oluşturur, Ayarlar'da gösterilen dönüş adresini (`http://localhost:<port>/auth/kick/callback`) kaydeder, Client ID ve Secret'ı girer ve "Kick hesabını bağla" der.

### Telefondan erişim

Varsayılan olarak Kesit'e yalnız kurulu olduğu bilgisayardan girilir. Ayarlar → Telefondan erişim açılınca aynı Wi-Fi'daki bir cihaz, bilgisayar ekranında üretilen 6 haneli kodla eşlenir (30 gün). Bilgisayar geneli ayarlar (altyazı motoru, çıktı klasörü, disk temizliği, telefon erişimi) yalnız bilgisayarın kendisinden değiştirilebilir.

## Komutlar

| Komut | İşi |
|---|---|
| `npm run dev` | Sunucu ve arayüzü izleme modunda başlatır |
| `npm test` | Veri katmanı, arşiv, dışa aktarma, kompozisyon/altyazı oranları, kuyruk, nöbet ayarı ve yönlendirme güvenliği testleri |
| `npm run build` | Tip denetimi ve üretim derlemesi |

## Yapı

```
server/index.ts         HTTP, ağ kapısı (yerel / eşlenmiş cihaz), korumalı /clips, socket.io
server/auth.ts          Kanal adıyla giriş, kendi Kick uygulamasıyla sohbet izni (PKCE), oturumlar
server/db/              SQLite şeması (sıralı göçler) ve Store (motorun beklediği veri metotları)
server/services/        Workspaces (kullanıcı başına motor), Autopilot (Nöbet), ClipHarvester (klip takibi),
                        Publishing (Zernio), KickChat (anlık klip), Captions (altyazı motoru),
                        Exporter (İndirilenler'e kopya), Storage (disk/temizlik), Retention (saklama),
                        LanAccess (telefon eşleme), ArchiveLedger (arşiv defteri)
server/routes/          Alan başına API uçları
server/engine/          Klip motoru (LivoBot'tan taşındı, CommonJS)
shared/                 İstemci ve sunucunun ortak tipleri
src/                    React arayüzü (screens, components, lib — lib/frame.ts önizleme oranları)
```

### Klip motoru

`server/engine` LivoBot'un klip editörü modülüdür. Kesit'e taşınırken yapılan değişiklikler:

- **Outro**: `HorizontalComposer`, `RecordingFinalizer` ve `ClipEditorManager` intro'ya ek olarak outro da ekler. `IntroStore` iki türü birlikte yönetir.
- **Yatay altyazı**: Yatay kesitlere altyazı basılır; ASS'in PlayRes'i kesitin kendi ölçüsüdür ve stil ölçüleri orantılı ölçeklenir (`Transcriber.scaleStyleLines`, `HorizontalComposer.subtitleLayout`). Yatayda varsayılan kapalıdır (`ClipEditorManager.groupDefaults`).
- **Zernio**: `ZernioPublisher` kullanıcı başına API anahtarı alır.
- **Kuyruk**: `VodScanManager` Redis yoksa süreç içi kuyruğa (`LocalQueue`) düşer.
- **Altyazı motoru**: `Transcriber` whisper ikilisini ve modelini çalışma anında okur.
- **Otomatik başlık/açıklama** ve **kayıt bitince otomatik çıktı** kapalıdır.

Motor `server/engine.ts` üzerinden içe aktarılır. Bu dosya ortam yapılandırmasının motordan önce yüklenmesini sağlar.

## Saklama

İndirilen yayınlar 7 gün sonra silinir; arşivde "süresi doldu" olarak kalır. Klip işine aktarılmış ara kesit dosyaları ve yarım kalmış iş dizinleri 1 gün sonra temizlenir. Silinen her içeriğin kaydı Arşiv'de durur.

## Güvenlik notları

- Sunucu yalnız `localhost`, loopback, yerel ağ IP'leri ve bu bilgisayarın adıyla gelen istekleri kabul eder (DNS rebinding'e karşı).
- Yerel ağ erişimi varsayılan kapalıdır; açıkken yalnız eşleme koduyla eşlenen cihazlar girer.
- Kanal adıyla girişte kanalın sahibi olduğun doğrulanmaz; bu yüzden erişim bilgisayarın kendisi ve eşlenen cihazlarla sınırlıdır.
- Zernio, ElevenLabs ve Kick uygulaması anahtarları AES-GCM ile şifreli, yalnız bu bilgisayarda tutulur. Kick dönüşü yalnız yerel adreslere yapılır.
- Üretilen dosyalar `/clips/<kullanıcı>/...` altında sunulur ve yalnız sahibine açıktır.
- Durum değiştiren isteklerde köken denetimi yapılır ve çerezler `SameSite=Lax` ile gönderilir.
- Misafir hesabı tarayıcıdaki oturum çerezine bağlıdır; sonradan Kick ile giriş yapılırsa misafirin işleri taşınmaz.
