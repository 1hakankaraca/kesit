# Kesit

Kick yayıncıları için klip stüdyosu. Kurulduğu bilgisayarda çalışır; bütün veriler o bilgisayarda kalır, hiçbir sunucuya bağlı değildir. Kick hesabıyla ya da misafir olarak girilir; açılışta editör düzeninde bir kütüphane karşılar. Her sayfada "Nasıl kullanılır" düğmesiyle açılan kısa bir rehber vardır.

- **Görünüm ve menü (0.3)**: Koyu stüdyo teması, tek vurgu rengi. Sol menü dört grupta: Kaynaklar (Canlı yayın, Kesitler, Geçmiş yayınlar, Kick klipleri), Kütüphane (Galeri, Editör, Paylaşım, Arşiv), Otomasyon (Bot takibi), Sistem (Görevler, Ayarlar). Altta her sayfada süren işleri gösteren durum çubuğu. Bütün ayarlar tek yerde: Ayarlar › Video ve marka · Abone çağrısı · Hesaplar ve servisler (Kick, Zernio, Claude, altyazı motoru) · Bilgisayar (klasör, disk, telefon). Eski /marka adresleri aynen çalışır.
- **İlk kurulum**: Giriş yapan yeni kullanıcı altı adımlık sihirbazla karşılanır: takip edilecek kanal (istenirse çevrimdışı bot takibi), logo, açılış/kapanış videosu, Zernio bağlantısı, genel ayarlar (altyazı motoru, çıktı klasörü) ve özet. Her adım "Şimdilik atla" ile geçilir; yüklenmeyen logo/intro/outro kliplere eklenmez. Sihirbaz Ayarlar'dan yeniden açılır.
- **Klipler**: Kanalın Kick/KickBot kliplerini tara, seç, toplu olarak dikey videoya çevir. Yüz kamerası tespiti, altyazı ve 9:16 kompozisyon otomatik yapılır. Klip bağlantısı yapıştırarak da eklenebilir.
- **Geçmiş yayınlar**: Kick'in sakladığı yayını indir; istersen "Aralık" ile yalnız belirli bir başlangıç–bitiş kısmını (dakika ya da sa:dk:sn) indir, aynı yayından istediğin kadar aralık al. Zaman çizelgesinde sürükleyerek ya da I/O ile kesit işaretle. **Anları tara** yayının tamamını Kick sohbeti (patlama, tekil kişi, KEKW/OHA/F gibi tepkiler), ses yükselmeleri ve konuşmaya göre tarayıp en komik, heyecanlı, aksiyonlu ve duygusal anları listeler (hiçbir şey kesmez); Ayarlar'da Claude anahtarı bağlıysa anları Claude etiketler ve başlık yazar.
- **Kanal sekmeleri**: Üst ortada Kick'te arayarak kanal seçilir; her yayıncı bir sekme olur, "+" yeni sekme açar. Etkin sekme tarama, kayıt ve nöbetin varsayılanıdır.
- **Canlı**: Elle yayın kaydı (geçmişten başlatılabilir), canlı önizleme, süren yayından indirme (şu ana kadarı ya da yazılan başlangıç–bitiş aralıkları; tek seferde birden çok aralık girilir, "şu andan geriye" kipiyle "80 dk önce → 50 dk önce" denebilir; bitiş ileride olabilir, yayın o ana gelince dosya kapanır ve Geçmiş yayınlar'a düşer), chat'e düşen klipleri yakalayıp otomatik işleme, anlık kesit düğmeleri ve kanala eklenen yeni Kick kliplerini arka planda indiren klip takibi.
- **Kesitler**: Yayın sürerken 30–180 sn düğmesine basınca yayının o kadar saniye öncesi Kick'in süren yayın kaydından alınır (sohbete hiçbir şey yazılmaz), ham olarak Kesitler'de listelenir, istenirse kendiliğinden dikey videoya çevrilir. Ham kesit indirilebilir; yayın kaydı canlıdan yarım dakika kadar geride geldiğinden kesit o kadar sonra iner. "Dışarıdan ekle" ile bilgisayardan dosya (sürükle-bırak) ya da Google Drive paylaşım bağlantısı / doğrudan video adresi de kesit olarak alınır ve istenirse dikeye çevrilir.
- **Nöbet**: Takip edilen kanalı arka planda yoklar. Yayın açılınca chat klip yakalamayı başlatır; yayın bitince Kick'in yayın kaydını indirir ve Geçmiş yayınlar'a koyar — hiçbir şey otomatik işlenmez, editörde sen kesersin. Tarayıcı kapalıyken de çalışır (Kesit açık ve bilgisayar uyanık olmalı); yeniden başlatmada geri kurulur.
- **Kayıtlar**: Yayına hazır çıktı, kesitleri ayrı klip/kesit olarak üretme, istenmeyen kısımları çıkarma, küçültülmüş indirme (sürerken iptal edilebilir), Zernio ile YouTube'a taslak → yayın.
- **Galeri**: Dosya yöneticisi gibi çalışır: iç içe klasörler, sağ tık menüleri (aç, editörde aç, indir, klasöre taşı, yeniden adlandır, sil), kartları ve klasörleri sürükle-bırakla taşıma, ⌘/Ctrl ve ⇧ ile çoklu seçim. Klasör silmek içindekileri silmez, bir üst klasöre taşır. Dikey videolar dikey kart olarak görünür; kartın üstünde bekleyince kart büyür ve video sesli oynar. Her işlenmiş klibin ham kaynağı saklanır: "Ham" ile indirilir, "Kadrajı düzelt" ile kamera ve oyun alanı ham kare üzerinde çizilip video yeniden üretilir. Süren işler Anasayfa, Galeri ve Görev yöneticisi'nden iptal edilir (alt süreçler öldürülür, ham kaynak kalır).
- **Paylaşım**: Her kullanıcı kendi Zernio API anahtarını bağlar. Anahtar veritabanında AES-GCM ile şifreli durur. Hemen ya da planlı paylaşım yapılabilir; TikTok için açık onay zorunludur.
- **Arşiv**: Üretilen her klip, kayıt ve indirilen yayın günlük bir defterde tutulur. Dosya silinse bile kayıt, küçük görsel ve paylaşım geçmişi kalır. Isı haritasından güne göre süzülebilir.
- **Ayarlar**: Kendi Kick uygulamanı bağlama (sohbete klip atma), altyazı motoru (önerilen yerel whisper modeli tek tıkla indirilir ya da ElevenLabs anahtarı bağlanır), hazır videoların kopyalanacağı klasör (varsayılan `~/Downloads/Kesit`, Dikey/Yatay/Kayıtlar), disk kullanımı ve önbellek/video temizliği, telefondan erişim (eşleme koduyla).
- **Silme**: Hiçbir silme onay sormaz; bildirimdeki "Geri al" ile 6 saniye içinde geri alınır.
- **Marka ve şablon**: Logo, marka/vurgu rengi ve altyazı stili. Üretim varsayılanları Dikey ve Yatay olarak ayrıdır; önizleme motorun gerçek oranlarıyla çizilir. Logo sürüklenir; merkeze, üçte birlere ve güvenli kenarlara yapışır, 3x3 hizalama vardır, %15'e kadar küçültülür. Dikeyde "Kamera + oyun" seçiliyken örnek bir yayın karesinde kamera ve oyun alanı çizilir; otomatik üretimler (Dikey klipler, canlı yakalama, bot takibi) bu kadrajı kullanır, kadraj yoksa ve yüz kamerası bulunamazsa varsayılan köşe kadrajına düşülür — bölünmüş düzen istenen klip asla tek kare çıkmaz. Üretim kuralları tek ve ortaktır: burada değişince dikey üretilen her şey (klipler, kesitler, yayın kesitleri, bot takibi, yeniden üretim) uyar. Her kanal sekmesine "bu sekme için özel" denerek yalnız ayrı logo, renk ve altyazı stili verilebilir (`channel_brands`, `clips/<kullanıcı>/brand/<kanal>/logo.png`). Dikey klipler sayfasındaki altyazı/yerleşim seçimi bu varsayılanlara yazılır, yani kalıcıdır. Yatayda altyazı varsayılan kapalıdır. Intro/outro yalnız yatay videolara eklenir. Çıktı ayarları Kayıtlar'daki "Çıktıyı üret" içindir; hiçbir çıktı kendiliğinden üretilmez.

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
                        Snippets (Kesitler: yayının son N saniyesi),
                        ChatHistory + ChatOverlay (editörde videoya bağlı Kick sohbeti: çekme ve dışa aktarma)
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

İki parça türü kaynak dosyası olmadan yalnız zaman çizelgesinde yaşar:
- **Abone çağrısı** (`kind: 'cta'`): Yazı ve Marka sekmelerinden eklenir; süresi animasyonun süresi (2–10 sn),
  tasarım/konum/boyut parçanın kendi ayarında (`clip.cta`: stil, kareye oranlı merkez `x`/`y`, boyut; sahnede sürüklenir, şerit stili yalnız dikey), yazılar ve renkler Stüdyo'daki marka ayarından.
  Önizlemede Stüdyo'nun küçük CSS kopyası (`CtaMini`) ölçeklenir; dışa aktarmada `ProjectCta.ctaEvents`
  her parçayı kendi penceresinde `SubscribeCta.eventsFor` ile ASS olayına çevirir ve altyazıyla aynı dosyaya katar.
  Stüdyo'da yüklenen abone kesiti (`cta.mp4`) de Marka sekmesinden sıradan bir video varlığı olarak bağlanır.
- **Kamera alanı** (`kind: 'cam'`): Düzen sekmesinden eklenir; `crop` ana videodaki webcam kutusudur
  (yüz kamerası tespiti, yoksa sağ üst köşe; sağ panelden elle çekilir). `expandCamClips` bu parçayı,
  aralığında ana yolda duran video kesimlerine böler ve her kesim için bölgeyi tüm kareyi dolduracak
  biçimde (`coverRegion`) kırpan sessiz bir tam kare katman üretir — önizleme ve ffmpeg planı aynı listeyi
  kullanır; parça bitince düzen eskisine döner.

**Kick sohbeti** iki parçadan oluşur: veri ve görünüm videoya (varlığa) bağlı bir *katmanda* durur (`project.chats`,
`shared/chat.ts`), ne zaman görüneceğini ise zaman çizelgesindeki *sohbet parçaları* (`kind: 'chat'`, `chatId` → katman)
belirler. Yazı sekmesinden "Kick sohbeti" ile eklenir: sunucu, videonun hangi yayına ve saate denk geldiğini kaynağından
bulur (indirilen yayın aralığı: `vod_scan_jobs.stream_started_at` + aralık başlangıcı — saniyesi belli; yayın kaydı
ve Kick klibi: yaklaşık, sağ paneldeki kaydırmayla düzeltilir) ve projede kullanılan bölümlerin sohbetini Kick'in
mesaj uç noktasından imleçle geriye sayfalayarak çeker (`ChatHistory`; veri `projects/<id>/chat/<varlık>.json`); seçili
parçanın (yoksa oynatma çizgisindeki ana videonun) aralığına bir sohbet parçası konur. Her mesajın zamanı kaynağın
saniyesidir; o anda hangi mesajların görüneceği karede duran video parçasının kaynak zamanından hesaplanır (`chatSegments`,
sohbet parçalarının aralığıyla kırpılır: `effectiveChatLayers`). Bu yüzden sohbet parçasını kısaltıp taşımak yalnız *ne
zaman* görüneceğini değiştirir; videoyu bölmek, aradan kesmek, sıra ve hız değiştirmek eşlemeyi bozamaz. Aynı videonun
sohbetine birden çok parça konabilir; kutunun yeri/boyutu ve görünüm katmanda ortaktır, sahnede sürüklenir. Katmanın son
parçası silinince katman da gider; parçasız katman (eski kayıt) her yerde görünür sayılır.

**Yayın çerçevesi** (`kind: 'frame'`) kamera alanı gibi zaman çizelgesinde yaşayan bir parçadır; kaynağı Stüdyo → Logo ve
görünüm → Kimlik'ten yüklenen saydam video pencereli 1920×1080 PNG'dir (`frame.png`; genel ya da kanal sekmesine özel, logo gibi).
Sunucu PNG'yi ffmpeg ile ham RGBA'ya açıp alfası düşük en büyük bitişik bölgeyi pencere olarak bulur (`StreamFrame`), sohbet alanı
küçük resim üstünde kutu çizilerek işaretlenir (`frame.json`). Editörde Marka → Yayın çerçevesi (yalnız yatay projede) çerçeveyi
görsel varlık olarak bağlar ve seçili parçanın (yoksa oynatma çizgisindeki ana videonun) aralığına, bölgeleri (`clip.regions`) parçanın
içinde olmak üzere bir çerçeve parçası koyar; parça kısaltılır, taşınır, silinir. `expandFrameClips` bu aralıkta ana yolda duran her
video kesimi için kaynağın kamera bölgesini (çerçeve parçasının `crop`u: eklenirken yüz kamerası aranır, yoksa sağ üst köşe;
sağ panelden "Tüm yayın" da seçilebilir) pencereye oran bozmadan oturtan (`coverRegion`) sessiz bir katman üretip çerçeve
görselinin hemen altına koyar;
çerçevenin kendisi tam kare görsel olarak kalır, aralık dışında düzen eskisidir (önizleme ve ffmpeg planı aynı listeyi kullanır; çerçevenin
bütünüyle kapsadığı kamera alanı da pencereyi doldurur). Kick sohbeti çerçeve aralığında panele oturur: `effectiveChatLayers` asıl katmanı
çerçeve aralıklarının dışında, çerçeve başına türetilen `<sohbet>_<çerçeve>` katmanını (panel kutusu, arka plansız, 21 px) yalnız o
aralıkta gösterir; dışa aktarmada her etkin katman kendi planını yükler ve plan anahtarı zaman kısıtını da taşır. Altyazı çerçeve
aralığındaki satırlarda pencerenin alt kenarının üstüne alınır (ASS satır başına MarginV).
Satırlar (rozetler, renkli kullanıcı adı, emote'lar) tek bir tuval çizicisiyle (`src/editor/chatRender.ts`) çıktı
çözünürlüğünde çizilir: önizleme bunları küçülterek gösterir; dışa aktarmada aynı satırlar uzun PNG sayfalarına
dizilip yüklenir ve `ChatOverlay` bunlardan saydam (RGBA) kareler derleyip ffmpeg'in standart girdisine ham video
olarak verir (10 kare/sn; altyazı ve abone çağrısının altında bindirilir). Emote ve rozet görselleri sunucuda
önbelleğe alınıp aynı kökenden sunulur (`/api/chat/emote/:id`, `/api/chat/img`). Hareketli emote'lar ilk
kareleriyle çizilir; görseli olmayan rozet türleri (moderatör, VIP…) sade simgelerle gösterilir.

### Klip motoru

`server/engine` LivoBot'un klip editörü modülüdür. Kesit'e taşınırken yapılan değişiklikler:

- **Outro**: `HorizontalComposer`, `RecordingFinalizer` ve `ClipEditorManager` intro'ya ek olarak outro da ekler. `IntroStore` iki türü birlikte yönetir.
- **Yatay altyazı**: Yatay kesitlere altyazı basılır; ASS'in PlayRes'i kesitin kendi ölçüsüdür ve stil ölçüleri orantılı ölçeklenir (`Transcriber.scaleStyleLines`, `HorizontalComposer.subtitleLayout`). Yatayda varsayılan kapalıdır (`ClipEditorManager.groupDefaults`).
- **Zernio**: `ZernioPublisher` kullanıcı başına API anahtarı alır.
- **Kuyruk**: `VodScanManager` Redis yoksa süreç içi kuyruğa (`LocalQueue`) düşer.
- **Altyazı motoru**: `Transcriber` whisper ikilisini ve modelini çalışma anında okur.
- **Ham kaynak ve iptal**: `ClipEditorManager` her işin kaynağını `raw/<id>.mp4` olarak saklar (yeniden üretim `reprocess` güncel ayarlarla çalışır, ham indirme). Alt süreçler `ProcTracker` ile iş anahtarına bağlanır; `cancel` sıradaki işi kuyruktan çıkarır, süren işin ffmpeg/whisper süreçlerini öldürür.
- **Abone çağrısı**: `SubscribeCta` iki parça ekler — marka renginde çizilen "abone ol / beğen / yorum yap" animasyonu (altı tasarım: haplar, şerit, kart, imleçli "tıkla", simgeler, yan dizi; simgeler ve imleç libass çizim komutlarıyla ASS olayı; altyazı varsa aynı dosyaya katılır, dikey ve yatay çıktıda aynı yol) ve kullanıcının yüklediği kısa kesitin (`cta.mp4`, sekme profilinde `brand/<slug>/cta.mp4`) nihai çıktının başına/ortasına/sonuna concat ile dikilmesi (oran uymuyorsa arkası bulanık). Animasyon biçim başına (`overlay.formats.vertical|horizontal`: açık/kapalı, yer, boyut yüzde 30–200) ve özel renkler (`overlay.colors`: ana, vurgu, yazı, koyu; boşsa marka rengi) ve kesit dikme biçim başına (`insert.formats`) ayarlanır. Ayar `user_settings.cta` ya da `channel_brands[slug].brand.cta`; Logo ve görünüm'ün "Abone çağrısı" iç sekmesi (`/marka/abone`) ve önizleme (`POST /api/studio/cta/preview`). Üretim seçeneği `ctaAuto` (varsayılan açık, Ayarlar › Video "Abone çağrısı otomatik"): `SubscribeCta.autoPlan` ayarın zamanlama ve biçim seçimini ezer — animasyon başta (yatayda intro sonrası) ve sonda (outro öncesi), yüklü kesit tam ortada (`D/2`, 10 sn altı atlanır), her iki biçimde; tasarım/yer/boyut/yazı/renk korunur. Kapalıyken Stüdyo'daki "Ne zaman" / "Nereye" / "Hangi videolara" geçerlidir.
- **GPU ile kodlama**: Tüm yeniden kodlamalar (dikey/yatay kompozisyon, abone kesiti dikme, kayıt çıktısı, sıkıştırma, proje dışa aktarma, içe alma) `VideoEncoder` üzerinden yapılır. Açılışta makinedeki ffmpeg'in donanım kodlayıcıları gerçek bir deneme kodlamasıyla sınanır (macOS: VideoToolbox; Windows: NVENC → Quick Sync → AMF; Linux: NVENC → Quick Sync) ve kodlama hattında kaynak da GPU'da çözülür. GPU işi hata verirse iş işlemciyle (libx264/libx265) bir kez daha denenir; üst üste 3 hatada o kodek işlemciye sabitlenir. `KESIT_VIDEO_ENCODER=cpu` GPU'yu kapatır. Seçilen kodlayıcı Görevler › Sistem'de görünür. Proje dışa aktarmada ilerleme 2 dakika boyunca hiç değişmezse ffmpeg kesilir ve iş işlemciyle yeniden denenir (Apple VideoToolbox ara sıra %0 işlemciyle sonsuza dek bekliyor; bu takılma hata üretmediğinden yedek tek başına devreye giremiyordu). Süzgeç ağırlıklı dışa aktarmalarda (ölçekleme, bindirme, sohbet akışı) GPU kodlama işlemciden hızlı değildir; darboğaz süzgeçlerdir. Analiz geçişleri (facecam, sahne, hareket) kısa ve gecikmeye duyarlı olduğundan işlemcide çözülür.
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
