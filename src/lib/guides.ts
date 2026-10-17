/** Sayfa rehberleri: her bölümün "nasıl kullanılır" içeriği, sade dille. */

export interface Guide {
  title: string;
  intro: string;
  steps: { title: string; text: string }[];
  tips?: string[];
}

export const GUIDES = {
  anasayfa: {
    title: 'Anasayfa',
    intro: 'Şu an hazırlanan videoların ilerlemesi, son bitenler ve hızlı başlangıç düğmeleri burada.',
    steps: [
      { title: 'İlerlemeyi izle', text: 'Hazırlanan her video bir kart olarak görünür; hangi adımda olduğu ve kalan süre canlı güncellenir.' },
      { title: 'Hızlı başla', text: 'Üstteki düğmelerle canlı yayına, dikey klip üretmeye ya da boş bir editör projesine geçersin.' },
      { title: 'Son bitenler', text: 'Yeni hazırlanan videolar aşağıda sıralanır; tıklayınca Galeri\'de açılır.' },
    ],
  },
  galeri: {
    title: 'Galeri nasıl kullanılır',
    intro: 'Hazırlanan her video, yayın kaydı ve editör projesi burada. Üstteki süzgeçlerle daraltır, karta tıklayıp izlersin.',
    steps: [
      { title: 'Süz', text: 'Üstten tür (dikey, yatay, yayın kaydı, proje), durum ve sıralama seç; arama kutusuna başlık ya da kanal yaz.' },
      { title: 'İzle', text: 'Karta tıklayınca video büyük oynatıcıda açılır; sağda ayrıntılar ve diğer videolar görünür.' },
      { title: 'Editörde aç', text: 'Her videoyu ya da yayın kaydını "Editörde aç" ile düzenleyebilirsin; yeni bir proje açılır.' },
      { title: 'İndir ya da paylaş', text: '"İndir" tam kaliteyi verir; "Ham" işlenmemiş kaynağı, 1080p/720p/480p daha küçük kopya indirir. "Paylaş" sosyal hesaplarına gönderir.' },
      { title: 'Kadrajı düzelt', text: 'Dikey video yanlış çıktıysa "Kadrajı düzelt" ile kamera ve oyun alanını ham kare üzerinde kendin çiz; video yeniden üretilir.' },
      { title: 'Sil', text: 'Kartın üstüne gelince çıkan çöp kutusu tek öğeyi siler. Birden çoğunu silmek için "Seç" de, kartlara tıkla (⇧ ile aralık, ⌘A ile hepsi), alttaki "Sil"e bas. Her silme 6 saniye geri alınabilir.' },
    ],
    tips: ['Kartın üstünde bekleyince video büyüyüp sesli oynar.', 'Hazırlanmakta olan öğeler bitene kadar silinemez; istersen iptal edebilirsin.', 'Yayın kayıtlarını "Paylaşıma hazırla" ile logo ve açılış/kapanış ekleyip YouTube\'a gönderebilirsin.'],
  },
  klipler: {
    title: 'Dikey klipler nasıl kullanılır',
    intro: 'Bir kanalın Kick kliplerini getirip seçtiklerini kendiliğinden dikey videoya (telefon ekranı boyutunda) çevirirsin.',
    steps: [
      { title: 'Kanalı seç', text: 'Üst ortadaki kanal sekmelerinden birini seç ya da arama kutusuna kanal adı yaz.' },
      { title: 'Klipleri getir ve izle', text: 'Küçük resme tıklayınca klip oynar. Zaman aralığını ve sıralamayı üstten değiştirebilirsin.' },
      { title: 'Seç', text: 'Kartın alt kısmına ya da köşedeki yuvarlağa tıklayarak en fazla 20 klip seç.' },
      { title: 'Otomatik işle', text: 'Alttaki çubukta "Otomatik işle"ye bas. Yüz kamerası kendiliğinden bulunur, kamera ve oyun alt alta dizilir, altyazı eklenir. Sen bu sayfada kalırsın; sonuçlar arkada hazırlanıp Galeri\'ye düşer.' },
      { title: 'Manuel hizala', text: 'Kamera yanlış bulunuyorsa "Manuel hizala"ya bas: klibin karesi üzerinde Kamera ve Yayın alanı kutularını kendin çiz, sağdaki önizlemede sonucu gör. Çizimin hatırlanır; seçili tüm kliplere uygulanır.' },
    ],
    tips: ['Tek bir klibin bağlantısı elindeyse sağdaki "Bağlantıdan ekle" kutusuna yapıştır.', 'Altyazı için Ayarlar\'da otomatik altyazı açık olmalı; kapattığın altyazı sen açana kadar kapalı kalır.', 'Hazır bir videoyu beğenmediysen Galeri\'de açıp "Kadrajı düzelt" ile ham kaynağından yeniden ürettirebilirsin.'],
  },
  yayinlar: {
    title: 'Yayın geçmişleri nasıl kullanılır',
    intro: 'Kick\'in sakladığı eski yayınları bilgisayarına indirip istediğin anları kesersin ya da editörde açarsın.',
    steps: [
      { title: 'Yayını indir', text: 'Aşağıdaki listeden bir yayın seç, "İndir"e bas. İndirme hızını ve kalan süreyi Görev yöneticisi\'nde görürsün.' },
      { title: 'Yalnız bir aralığı indir', text: '"Aralık" ile başlangıç ve bitişi yaz (dakika ya da sa:dk:sn); yalnız o kısım iner. Aynı yayından istediğin kadar aralık alabilirsin.' },
      { title: 'Kes', text: 'İnen yayın üstte "Düzenlemeye hazır" kısmında görünür. "Kes" hızlı kesim ekranını açar; "Editörde aç" tam editöre götürür.' },
      { title: 'Kesit işaretle', text: '"Kesit seç" moduna geç (C tuşu) ve şeritte sürükle. Ya da oynatırken I (başlangıç) ve O (bitiş) tuşlarına basıp Enter\'la ekle.' },
      { title: 'Hazırla', text: 'Sağda dikey video ya da yatay kesit seç ve "Kesitleri üret"e bas. İstersen işaretlediğin kesitleri editörde de açabilirsin.' },
    ],
    tips: ['"İzle" modunda şeride tıklayınca ya da çizgiyi sürükleyince o ana gidersin.', '"Ekran görüntüsü" (S tuşu) o anki kareyi İndirilenler/Kesit klasörüne kaydeder.', 'İnen yayınlar 7 gün saklanır.'],
  },
  canli: {
    title: 'Canlı yayın nasıl kullanılır',
    intro: 'Süren bir yayını kaydeder, klipleri yakalar ve anlık kesit alırsın. Sen yokken kendiliğinden olsun istiyorsan Çevrimdışı bot takibi kullan.',
    steps: [
      { title: 'Kaydı başlat', text: '"Şimdiden" ya da geçmişten bir başlangıç seç ve "Kaydı başlat"a bas. Durdurunca kayıt Galeri\'ye düşer.' },
      { title: 'Yayından aralık indir', text: '"Belirli aralığı indir" ile başlangıç ve bitişi yaz; "Aralık ekle" ile birden çok aralık yazabilirsin. "Şu andan geriye" kipinde "80 → 50" demek 80 dk önceden 50 dk önceye demektir. Bitiş ileride olabilir: yayın o ana gelince dosya kapanır.' },
      { title: 'Klipleri dinle', text: '"Dinlemeye başla" ile hem sohbete atılan klipler hem de kanala Kick\'te eklenen yeni klipler yakalanıp indirilir. "Otomatik düzenle" açıksa dikey videoya da çevrilir.' },
      { title: 'Anlık kesit al', text: 'Yayın sırasında 30–180 sn düğmelerinden birine bas: yayının o kadar saniye öncesi Kick\'in yayın kaydından alınır, Kesitler bölümüne iner ve istersen dikey videoya çevrilir. Sohbete hiçbir şey yazılmaz.' },
    ],
    tips: ['Kick\'in yayın kaydı canlıdan yarım dakika kadar geride gelir; kesit o kadar sonra iner.'],
  },
  kesitler: {
    title: 'Kesitler nasıl kullanılır',
    intro: 'Yayın sürerken bir düğmeyle yayının son 30–180 saniyesini alırsın. Ham kesit burada durur; dikey videoya çevrilen hali Galeri\'de de görünür.',
    steps: [
      { title: 'Kesit al', text: 'Kanal yayındayken soldaki süre düğmesine bas. Yayın kaydı canlıdan biraz geride geldiği için kesit yarım dakika içinde iner.' },
      { title: 'İzle ya da indir', text: 'Küçük resme tıklayınca kesit oynar; "Ham" düğmesi dosyayı olduğu gibi indirir.' },
      { title: 'Dikey videoya çevir', text: '"Kesit inince dikey videoya çevir" açıksa kendiliğinden olur; kapalıysa her kesitin yanındaki düğmeyle sen başlatırsın. Sonuç Galeri\'de.' },
    ],
    tips: ['Yeniden üretmek istediğin dikey videoyu Galeri\'de açıp "Kadrajı düzelt" ile kamera ve oyun alanını kendin çizebilirsin.'],
  },
  nobet: {
    title: 'Çevrimdışı bot takip nasıl kullanılır',
    intro: 'Kesit açık ve bilgisayar uyanık olduğu sürece takip ettiğin kanalı arka planda izler. Tarayıcıyı kapatabilirsin.',
    steps: [
      { title: 'Kanalı yaz', text: 'Takip edilecek kanalı gir. Kendi kanalın olmak zorunda değil.' },
      { title: 'Ne yapılacağını seç', text: 'Yayın bitince yayını indirme, klipleri yakalama, yakalananları dikey videoya çevirme ve istersen kendiliğinden paylaşma.' },
      { title: 'Takibi başlat', text: 'Kesit kanalı birkaç dakikada bir kontrol eder. Yayın açılınca aşağıdaki günlükte görünür.' },
      { title: 'Sonuçları topla', text: 'Yayın bitince yayının tamamı indirilir, Yayın geçmişleri\'nde seni bekler. Yakalanan klipler Galeri\'de.' },
    ],
    tips: ['Bilgisayar uykuya geçerse takip de durur; uzun süre bırakacaksan uyku modunu kapat.'],
  },
  editor: {
    title: 'Editör nasıl kullanılır',
    intro: 'Boş bir projeyle başla; galeriden ya da bilgisayardan video, görsel ve müzik ekle; kes, üst üste koy, yazı ve logo ekle, renk ver, altyazı bas ve dışa aktar.',
    steps: [
      { title: 'Dosya ekle', text: 'Soldaki "Ekle" ile Galeri\'den (videolar, yayın kayıtları, indirilen yayınlar) ya da bilgisayardan dosya seç. Tıklayınca oynatma çizgisinin olduğu yere gelir.' },
      { title: 'Kes ve diz', text: 'Alttaki zaman çizelgesinde parçayı sürükle, kenarından kısalt; S tuşu oynatma çizgisinden ikiye böler. Araya istemediğin kısmı böl, seç ve Sil.' },
      { title: 'Üst üste koy', text: 'İkinci görüntü parçasını üstteki katmana koy; önizlemede sürükleyip küçült. Logo, görsel ve yazı da aynı şekilde yerleşir.' },
      { title: 'Dikeye çevir', text: 'Proje 9:16 iken bir yayın parçasını seçip "Kamera + ekran" de; yüz kamerası ve oyun ekranı ayrı katman olur, her birini ayrı hizalarsın.' },
      { title: 'Renk ve ses', text: 'Sağdaki panelden hazır renk tonları, parlaklık, kontrast, doygunluk; ses seviyesi ve sessize alma.' },
      { title: 'Altyazı ve dışa aktar', text: '"Konuşmayı yazıya dök" ile otomatik altyazı ekle, projede altyazıyı aç; "Dışa aktar" videoyu hazırlar ve Galeri\'ye düşürür.' },
    ],
    tips: ['Boşluk oynat/durdur · S böl · Sil parçayı kaldır · ⌘Z geri al · ⌘D çoğalt · ← → 1 kare', 'Proje kendiliğinden kaydedilir; istediğin zaman geri dönebilirsin.'],
  },
  gorevler: {
    title: 'Görev yöneticisi',
    intro: 'Bilgisayarın işlemci, bellek ve disk durumu; Kesit\'in çalıştırdığı işlemler ve süren işler.',
    steps: [
      { title: 'Sistemi izle', text: 'Üstteki göstergeler işlemci, bellek ve disk kullanımını canlı gösterir.' },
      { title: 'İşlemler', text: 'Kesit\'in başlattığı her ffmpeg/altyazı işlemi listede; takılan bir işlemi "Sonlandır" ile durdurabilirsin.' },
      { title: 'İşler', text: 'İnenler, hazırlananlar, bitenler ve hatalılar; yüzde, hız ve kalan süreyle. İstersen duraklat ya da iptal et.' },
    ],
    tips: ['Sol menüdeki sayı, şu an süren iş sayısıdır.'],
  },
  paylasim: {
    title: 'Paylaşım nasıl kullanılır',
    intro: 'Kesit videolarını sosyal hesaplarına Zernio adlı hizmet üzerinden gönderir. Bir kez bağlarsın, sonra tek tıkla ya da ileri bir tarihe paylaşırsın.',
    steps: [
      { title: 'Zernio\'yu bağla', text: 'Sağdaki adımları izleyerek anahtarını gir ve profilini seç.' },
      { title: 'Galeri\'den paylaş', text: 'Bir video seç, "Paylaş"a bas, hesapları işaretle. Hemen gönderebilir ya da tarih/saat seçebilirsin.' },
      { title: 'Takip et', text: 'Planlananlar ve gönderilenler bu sayfada listelenir.' },
    ],
    tips: ['TikTok her gönderide önizleme ve onay ister; bu yüzden kendiliğinden paylaşılamaz.'],
  },
  arsiv: {
    title: 'Arşiv nasıl kullanılır',
    intro: 'Hazırlanan ve paylaşılan her şeyin günlük kaydı. Dosyalar silinse bile kayıtları kalır.',
    steps: [
      { title: 'Güne göre bak', text: 'Üstteki her kare bir gün; koyu renk o gün çok video hazırlandığını, alttaki yeşil çizgi paylaşım yapıldığını gösterir. Kareye tıklayıp o güne bak.' },
      { title: 'Ara', text: 'Başlık ya da kanal adıyla ara; yalnız videoları, kayıtları ya da indirilen yayınları göster.' },
      { title: 'Geçmişi gör', text: 'Silinmiş olanlar soluk görünür ve ne zaman silindiği yazar. Dosyası duranları "Aç" ile açabilirsin.' },
    ],
  },
  marka: {
    title: 'Logo ve görünüm nasıl kullanılır',
    intro: 'Logo, renk ve altyazı görünümünü bir kez ayarla. Dikey ve yatay videoların ayarları ayrıdır; istersen her kanal sekmesine ayrı logo ve görünüm verirsin.',
    steps: [
      { title: 'Kimi ayarlıyorsun', text: 'Üstte "Genel" tüm sekmeler için geçerlidir. Seçili sekmenin adına tıklayıp "Bu sekme için özel ayar oluştur" dersen o kanalın logosu, renkleri ve üretim ayarları ayrı tutulur.' },
      { title: 'Kimliğini ayarla', text: 'Sağda logoyu yükle (arka planı şeffaf PNG en iyisi), renklerini ve altyazı stilini seç; "Kimliği kaydet".' },
      { title: 'Biçimi seç', text: 'Dikey 9:16 ya da Yatay 16:9 sekmesini seç. Önizleme o biçimi gerçek oranlarıyla gösterir.' },
      { title: 'Kadrajı çiz', text: 'Dikeyde "Kamera + oyun" seçiliyken "Kadrajı çiz" ile örnek bir yayın karesinde kamera ve oyun alanını işaretle. Otomatik üretimler bu kadrajı kullanır; yüz araması yapılmaz.' },
      { title: 'Yerleştir ve kaydet', text: 'Logoyu önizlemede sürükle; ortaya ve kenarlara gelince çizgi çıkar ve oraya oturur. Her biçimin ayarını kendi düğmesiyle kaydet.' },
    ],
    tips: ['Yatay videolarda altyazı başta kapalıdır; istersen açarsın.', 'Örnek kare için bir yayın indirilmiş ya da kayıt alınmış olmalı; yoksa bilgisayarından bir ekran görüntüsü seçebilirsin.'],
  },
  ayarlar: {
    title: 'Ayarlar',
    intro: 'Sohbete klip atma, otomatik altyazı, videoların kaydedileceği klasör, kapladığı yer ve telefondan erişim.',
    steps: [
      { title: 'Sohbete klip atma', text: 'Kick\'te kendi uygulamanı oluştur, gösterilen adresi kaydet, iki anahtarı gir ve "Kick hesabını bağla". Anahtarlar yalnız bu bilgisayarda kalır.' },
      { title: 'Otomatik altyazı', text: 'Önerilen ücretsiz modeli bir kez indir ya da ElevenLabs anahtarını bağla.' },
      { title: 'Kayıt klasörü', text: 'Hazır videolar ve ekran görüntüleri İndirilenler/Kesit klasörüne kaydedilir. İstersen değiştirebilirsin.' },
      { title: 'Yer aç', text: 'Neyin ne kadar yer kapladığını gör. Geçici dosyaları silmek güvenlidir.' },
    ],
    tips: ['Telefondan açmak için "Telefondan ve uzaktan erişim"i aç ve telefonda ekrandaki kodu gir.', 'Evden uzaktayken açmak için bilgisayara ve telefona Tailscale kur; port açılmaz, Kesit Tailscale adresinden aynı kodla açılır.'],
  },
} satisfies Record<string, Guide>;

export type GuideKey = keyof typeof GUIDES;
