# Kesit

Kick yayıncıları için klip stüdyosu. Kurulduğu bilgisayarda çalışır; bütün veriler o bilgisayarda kalır, hiçbir sunucuya bağlı değildir. Kick hesabıyla ya da misafir olarak girilir; açılışta editör düzeninde bir kütüphane karşılar. Her sayfada "Nasıl kullanılır" rehberi vardır ve ilk ziyarette kendiliğinden açılır.

- **İlk kurulum**: Giriş yapan yeni kullanıcı altı adımlık sihirbazla karşılanır: takip edilecek kanal (istenirse çevrimdışı bot takibi), logo, açılış/kapanış videosu, Zernio bağlantısı, genel ayarlar (altyazı motoru, çıktı klasörü) ve özet. Her adım "Şimdilik atla" ile geçilir; yüklenmeyen logo/intro/outro kliplere eklenmez. Sihirbaz Ayarlar'dan yeniden açılır.
- **Klipler**: Kanalın Kick/KickBot kliplerini tara, seç, toplu olarak dikey videoya çevir. Yüz kamerası tespiti, altyazı ve 9:16 kompozisyon otomatik yapılır. Klip bağlantısı yapıştırarak da eklenebilir.
- **Geçmiş yayınlar**: Kick'in sakladığı yayını indir; istersen "Aralık" ile yalnız belirli bir başlangıç–bitiş kısmını (dakika ya da sa:dk:sn) indir, aynı yayından istediğin kadar aralık al. Zaman çizelgesinde sürükleyerek ya da I/O ile kesit işaretle, en iyi anları otomatik buldur.
- **Kanal sekmeleri**: Üst ortada Kick'te arayarak kanal seçilir; her yayıncı bir sekme olur, "+" yeni sekme açar. Etkin sekme tarama, kayıt ve nöbetin varsayılanıdır.
- **Canlı**: Elle yayın kaydı (geçmişten başlatılabilir), canlı önizleme, süren yayından indirme (şu ana kadarı ya da yazılan başlangıç–bitiş aralıkları; tek seferde birden çok aralık girilir, "şu andan geriye" kipiyle "80 dk önce → 50 dk önce" denebilir; bitiş ileride olabilir, yayın o ana gelince dosya kapanır ve Geçmiş yayınlar'a düşer), chat'e düşen klipleri yakalayıp otomatik işleme, anlık kesit düğmeleri ve kanala eklenen yeni Kick kliplerini arka planda indiren klip takibi.
- **Kesitler**: Yayın sürerken 30–180 sn düğmesine basınca yayının o kadar saniye öncesi Kick'in süren yayın kaydından alınır (sohbete hiçbir şey yazılmaz), ham olarak Kesitler'de listelenir, istenirse kendiliğinden dikey videoya çevrilir. Ham kesit indirilebilir; yayın kaydı canlıdan yarım dakika kadar geride geldiğinden kesit o kadar sonra iner.
- **Nöbet**: Takip edilen kanalı arka planda yoklar. Yayın açılınca chat klip yakalamayı başlatır; yayın bitince Kick'in yayın kaydını indirir ve Geçmiş yayınlar'a koyar — hiçbir şey otomatik işlenmez, editörde sen kesersin. Tarayıcı kapalıyken de çalışır (Kesit açık ve bilgisayar uyanık olmalı); yeniden başlatmada geri kurulur.
- **Kayıtlar**: Yayına hazır çıktı, kesitleri ayrı klip/kesit olarak üretme, istenmeyen kısımları çıkarma, küçültülmüş indirme (sürerken iptal edilebilir), Zernio ile YouTube'a taslak → yayın.
- **Galeri**: Dikey videolar dikey kart olarak görünür; kartın üstünde bekleyince kart büyür ve video sesli oynar. Her işlenmiş klibin ham kaynağı saklanır: "Ham" ile indirilir, "Kadrajı düzelt" ile kamera ve oyun alanı ham kare üzerinde çizilip video yeniden üretilir. Süren işler Anasayfa, Galeri ve Görev yöneticisi'nden iptal edilir (alt süreçler öldürülür, ham kaynak kalır).
- **Paylaşım**: Her kullanıcı kendi Zernio API anahtarını bağlar. Anahtar veritabanında AES-GCM ile şifreli durur. Hemen ya da planlı paylaşım yapılabilir; TikTok için açık onay zorunludur.
- **Arşiv**: Üretilen her klip, kayıt ve indirilen yayın günlük bir defterde tutulur. Dosya silinse bile kayıt, küçük görsel ve paylaşım geçmişi kalır. Isı haritasından güne göre süzülebilir.
- **Ayarlar**: Kendi Kick uygulamanı bağlama (sohbete klip atma), altyazı motoru (önerilen yerel whisper modeli tek tıkla indirilir ya da ElevenLabs anahtarı bağlanır), hazır videoların kopyalanacağı klasör (varsayılan `~/Downloads/Kesit`, Dikey/Yatay/Kayıtlar), disk kullanımı ve önbellek/video temizliği, telefondan erişim (eşleme koduyla).
- **Silme**: Hiçbir silme onay sormaz; bildirimdeki "Geri al" ile 6 saniye içinde geri alınır.
- **Marka ve şablon**: Logo, marka/vurgu rengi ve altyazı stili. Üretim varsayılanları Dikey ve Yatay olarak ayrıdır; önizleme motorun gerçek oranlarıyla çizilir. Logo sürüklenir; merkeze, üçte birlere ve güvenli kenarlara yapışır, 3x3 hizalama vardır, %15'e kadar küçültülür. Dikeyde "Kamera + oyun" seçiliyken örnek bir yayın karesinde kamera ve oyun alanı çizilir; otomatik üretimler (Dikey klipler, canlı yakalama, bot takibi) bu kadrajı kullanır, kadraj yoksa ve yüz kamerası bulunamazsa varsayılan köşe kadrajına düşülür — bölünmüş düzen istenen klip asla tek kare çıkmaz. Her kanal sekmesine "bu sekme için özel" denerek ayrı logo, renk ve üretim ayarı verilebilir (`channel_brands`, `clips/<kullanıcı>/brand/<kanal>/logo.png`). Dikey klipler sayfasındaki altyazı/yerleşim seçimi bu varsayılanlara yazılır, yani kalıcıdır. Yatayda altyazı varsayılan kapalıdır. Intro/outro yalnız yatay videolara eklenir. Çıktı ayarları Kayıtlar'daki "Çıktıyı üret" içindir; hiçbir çıktı kendiliğinden üretilmez.

## Kurulum (Kesit App)

Node ya da ffmpeg kurmadan kullanmak için **Kesit App** indir: Windows'ta `.exe`, macOS'ta `.dmg`. [Releases](https://github.com/1hakankaraca/kesit/releases) sayfasındaki son sürümden:

| Sistem | Dosya |
|---|---|
| Windows 10/11 (64 bit) | `Kesit App-<sürüm>-win-x64.exe` |
| macOS Apple Silicon (M1 ve sonrası) | `Kesit App-<sürüm>-mac-arm64.pkg` (önerilen) ya da `.dmg` |
| macOS Intel | `Kesit App-<sürüm>-mac-x64.pkg` (önerilen) ya da `.dmg` |

Kesit App küçük bir araçtır: ilk açılışta kurulumu yapar (ffmpeg/ffprobe paketle gelir; yerel altyazı için whisper Windows'ta indirilir, macOS'ta Homebrew varsa kurulur), sunucuyu başlatır/durdurur, portu başka bir program tutuyorsa onu kapatıp kendi sunucusunu açar, çalışma süresini ve günlüğü gösterir, güncellemeleri kontrol eder ve tepside bekler. Sunucu çalışınca "Uygulamayı aç" tarayıcıda **http://kesit.localhost** adresini açar (Chrome, Edge, Firefox; Safari'de `http://localhost:3002`). Veriler kullanıcı klasöründe tutulur; Ayarlar'dan port, veri klasörü, açılışta başlatma ve tepsi davranışı değiştirilir, en altta uygulamayı ve tüm verileri silen kaldırma düğmesi vardır.

- **Windows**: kurulum dosyası imzalı olmadığı için SmartScreen "tanınmayan uygulama" uyarısı verebilir; "Ek bilgi → Yine de çalıştır" ile kurulur. Güncellemeler uygulama içinden indirilip kurulur.
- **macOS**: Apple geliştirici sertifikası olmadığından paket ad-hoc imzalıdır ve notarize edilmemiştir. İnternetten inen her dosyaya macOS "karantina" işareti koyar; bu işaretli bir uygulama için Gatekeeper **"hasarlı, açılamıyor"** der (sağ tık → Aç bu durumda işe yaramaz). İki yol:
  - **`.pkg` (önerilen)**: Çift tıkla. macOS "doğrulanamadı" diye engellerse Sistem Ayarları → Gizlilik ve Güvenlik → en altta **"Yine de Aç"**. Kurulum paketi uygulamayı Applications'a karantinasız koyar; uygulama doğrudan açılır.
  - **`.dmg`**: Uygulamayı Applications'a sürükledikten sonra Terminal'de şunu çalıştır: `xattr -dr com.apple.quarantine "/Applications/Kesit App.app"`.
  
  Güncellemeleri uygulama kendisi yapar: yeni sürümün .zip'ini indirir, karantina işaretini kaldırır, kendini değiştirip yeniden başlar (Applications'a yazamazsa kurulum paketini tarayıcıda açar).
- Yerel altyazı için `whisper-cli` paketle gelir; yoksa `brew install whisper-cpp` ya da Ayarlar'da ElevenLabs anahtarı kullanılabilir.

Geliştirici tarafı `desktop/` altındadır (Electron). `npm run desktop:dev` uygulamayı kaynak koddan açar; `npm run desktop:dist` bu bilgisayarın paketini `desktop/release/` altına üretir. `v*` etiketi atılınca GitHub Actions (`.github/workflows/release.yml`) macOS ve Windows paketlerini derleyip Release'e yükler; uygulamadaki "Güncelleme ara" bu Release'i okur.

## Çalıştırma (kaynak koddan)

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

### Telefondan ve uzaktan erişim

Varsayılan olarak Kesit'e yalnız kurulu olduğu bilgisayardan girilir. Ayarlar → Telefondan ve uzaktan erişim açılınca aynı Wi-Fi'daki bir cihaz, bilgisayar ekranında üretilen 6 haneli kodla eşlenir (30 gün). Bilgisayar geneli ayarlar (altyazı motoru, çıktı klasörü, disk temizliği, telefon erişimi) yalnız bilgisayarın kendisinden değiştirilebilir.

Evden uzaktayken yönetmek için port açılmaz: bilgisayara ve telefona/laptopa [Tailscale](https://tailscale.com/download) kurulur. Tailscale'in 100.64/10 aralığı yerel ağ sayılır; Ayarlar'da Tailscale adresi görünür ve o adres aynı eşleme koduyla açılır. Erişim gerekmediğinde anahtar kapatılır.

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
                        LanAccess (telefon eşleme), ArchiveLedger (arşiv defteri),
                        Projects + ProjectRenderer (editör projeleri ve ffmpeg dışa aktarma),
                        SystemMonitor (görev yöneticisi: işlemci/bellek/disk/süreçler),
                        Snippets (Kesitler: yayının son N saniyesi)
server/routes/          Alan başına API uçları
server/engine/          Klip motoru (LivoBot'tan taşındı, CommonJS)
shared/                 İstemci ve sunucunun ortak tipleri
src/                    React arayüzü (screens, components, lib — lib/frame.ts önizleme oranları)
src/editor/             Editör: proje modeli işlemleri (model.ts), önizleme sahnesi (Stage), çok yollu
                        zaman çizelgesi (Tracks), paneller ve dışa aktarma akışı
```

### Editör

Proje modeli `shared/project.ts`'te tanımlıdır; tüm konumlar karenin oranı (0–1) olarak tutulur.
Önizleme tarayıcıda DOM katmanlarıyla çizilir (video/görsel/yazı + CSS süzgeçleri); dışa aktarmada
aynı proje `ProjectRenderer.buildRenderPlan` ile tek bir ffmpeg `filter_complex` komutuna çevrilir
(crop → scale → eq/hue → overlay; sesler adelay + amix; altyazı en üstte). Yazı parçaları dışa
aktarmadan önce tarayıcıda çıktı çözünürlüğünde PNG'ye çizilip görsel varlık olarak yüklenir — böylece
sunucu yazı tipine bağımlı değildir. Çıktı Galeri'ye hazır video (`edited_clips`, source=editor) olarak düşer.

### Klip motoru

`server/engine` LivoBot'un klip editörü modülüdür. Kesit'e taşınırken yapılan değişiklikler:

- **Outro**: `HorizontalComposer`, `RecordingFinalizer` ve `ClipEditorManager` intro'ya ek olarak outro da ekler. `IntroStore` iki türü birlikte yönetir.
- **Yatay altyazı**: Yatay kesitlere altyazı basılır; ASS'in PlayRes'i kesitin kendi ölçüsüdür ve stil ölçüleri orantılı ölçeklenir (`Transcriber.scaleStyleLines`, `HorizontalComposer.subtitleLayout`). Yatayda varsayılan kapalıdır (`ClipEditorManager.groupDefaults`).
- **Zernio**: `ZernioPublisher` kullanıcı başına API anahtarı alır.
- **Kuyruk**: `VodScanManager` Redis yoksa süreç içi kuyruğa (`LocalQueue`) düşer.
- **Altyazı motoru**: `Transcriber` whisper ikilisini ve modelini çalışma anında okur.
- **Ham kaynak ve iptal**: `ClipEditorManager` her işin kaynağını `raw/<id>.mp4` olarak saklar (yeniden üretim `reprocess`, ham indirme). Alt süreçler `ProcTracker` ile iş anahtarına bağlanır; `cancel` sıradaki işi kuyruktan çıkarır, süren işin ffmpeg/whisper süreçlerini öldürür.
- **Otomatik başlık/açıklama** ve **kayıt bitince otomatik çıktı** kapalıdır.

Motor `server/engine.ts` üzerinden içe aktarılır. Bu dosya ortam yapılandırmasının motordan önce yüklenmesini sağlar.

## Saklama

İndirilen yayınlar 7 gün sonra silinir; arşivde "süresi doldu" olarak kalır. Klip işine aktarılmış ara kesit dosyaları ve yarım kalmış iş dizinleri 1 gün sonra temizlenir. Silinen her içeriğin kaydı Arşiv'de durur.

## Güvenlik notları

- Sunucu yalnız `localhost`, loopback, yerel ağ IP'leri ve bu bilgisayarın adıyla gelen istekleri kabul eder (DNS rebinding'e karşı).
- Yerel ağ erişimi varsayılan kapalıdır; açıkken yalnız eşleme koduyla eşlenen cihazlar girer. Tailscale (100.64/10) adresleri yerel ağ gibi değerlendirilir; genel internet adreslerinden gelen istekler her zaman reddedilir.
- Kanal adıyla girişte kanalın sahibi olduğun doğrulanmaz; bu yüzden erişim bilgisayarın kendisi ve eşlenen cihazlarla sınırlıdır.
- Zernio, ElevenLabs ve Kick uygulaması anahtarları AES-GCM ile şifreli, yalnız bu bilgisayarda tutulur. Kick dönüşü yalnız yerel adreslere yapılır.
- Üretilen dosyalar `/clips/<kullanıcı>/...` altında sunulur ve yalnız sahibine açıktır.
- Durum değiştiren isteklerde köken denetimi yapılır ve çerezler `SameSite=Lax` ile gönderilir.
- Misafir hesabı tarayıcıdaki oturum çerezine bağlıdır; sonradan Kick ile giriş yapılırsa misafirin işleri taşınmaz.
