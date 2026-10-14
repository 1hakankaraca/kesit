/** Sayfa rehberleri: her çalışma alanının "nasıl kullanılır" içeriği. */

export interface Guide {
  title: string;
  intro: string;
  steps: { title: string; text: string }[];
  tips?: string[];
}

export const GUIDES = {
  kutuphane: {
    title: 'Kütüphane nasıl kullanılır',
    intro: 'Ürettiğin her dikey klip ve yatay kesit burada toplanır. Solda liste, ortada önizleme, sağda ayrıntılar var.',
    steps: [
      { title: 'Klip seç', text: 'Soldaki listeden bir klibe tıkla; ortada oynatılır. Üstteki filtrelerle dikey/yatay ya da hazır/süren/hatalı olanları ayır.' },
      { title: 'İzle ve kontrol et', text: 'Kalite kontrolü bir sorun bulduysa sağda uyarı görünür. Paylaşmadan önce baştan sona izle.' },
      { title: 'İndir ya da paylaş', text: '"İndir" tam kaliteyi verir; 1080p/720p/480p düğmeleri küçültülmüş bir kopya hazırlayıp indirir. "Paylaş" Zernio ile sosyal hesaplarına gönderir.' },
      { title: 'Temizle', text: 'İşine yaramayan klibi sil. Dosya diskten gider ama Arşiv\'de ne zaman üretildiği görünmeye devam eder.' },
    ],
    tips: ['Süren işler sağ alttaki tepside ilerleme çubuğuyla görünür; sayfadan çıksan da işlenmeye devam eder.'],
  },
  klipler: {
    title: 'Klipler nasıl kullanılır',
    intro: 'Bir kanalın Kick kliplerini getirip seçtiklerini otomatik olarak dikey videoya (9:16) çevirirsin.',
    steps: [
      { title: 'Kanalı belirle', text: 'Üst ortadaki kanal sekmelerinden birini seç ya da arama kutusuna başka bir kanal yaz.' },
      { title: 'Klipleri getir', text: 'Kaynağı (Kick ya da KickBot), zaman aralığını ve sıralamayı seç. Daha fazlası için sayfanın altındaki düğmeyi kullan.' },
      { title: 'Seç', text: 'Kartlara tıklayarak en fazla 20 klip seç. Daha önce işlenenlerde "İşlendi" etiketi görünür.' },
      { title: 'Üret', text: 'Alttaki çubukta "Dikey klip üret"e bas. Yüz kamerası bulunur, kamera + oyun düzeni kurulur, altyazı eklenir.' },
    ],
    tips: ['Tek bir klibin bağlantısı elindeyse sağdaki "Bağlantıdan ekle" kutusuna yapıştırman yeterli.', 'Altyazı için Ayarlar\'da bir altyazı motoru kurulu olmalı.'],
  },
  yayinlar: {
    title: 'Geçmiş yayınlar nasıl kullanılır',
    intro: 'Kick\'in sakladığı eski yayınları bilgisayarına indirip zaman çizelgesinde istediğin anları kesersin.',
    steps: [
      { title: 'Yayını indir', text: 'Listeden bir yayın seç ve "İndir"e bas. Kaliteyi üstten değiştirebilirsin. İnen yayın sağdaki "İndirilenler"e düşer.' },
      { title: 'Editörü aç', text: 'İndirme bitince "Editörde aç". Üstte oynatıcı, altta film şeridi ve zaman çizelgesi var.' },
      { title: 'Kesit işaretle', text: 'Şeritte sürükleyerek bir aralık çiz. Ya da oynatırken I (giriş) ve O (çıkış) tuşlarına basıp Enter ile ekle. Kesiti taşı ya da kenarından uzat.' },
      { title: 'Üret', text: 'Sağda biçimi seç (dikey klip ya da yatay kesit) ve "Kesitleri üret"e bas. Sonuçlar Kütüphane\'ye düşer.' },
    ],
    tips: ['"En iyi anları çıkar" konuşma ve sahne değişimlerinden güçlü anları bulup kendisi dikey klip üretir.', 'İnen yayınlar 7 gün saklanır.'],
  },
  canli: {
    title: 'Canlı nasıl kullanılır',
    intro: 'Şu anda süren bir yayını elle kaydeder ve chat\'te paylaşılan klipleri yakalarsın. Sen yokken otomatik olsun istiyorsan Nöbet\'i kullan.',
    steps: [
      { title: 'Kanal yayında mı bak', text: 'Üstteki şerit kanalın canlı olup olmadığını, başlığını ve izleyici sayısını gösterir.' },
      { title: 'Kaydı başlat', text: '"Şimdiden" ya da geçmişten bir başlangıç seç ve "Kaydı başlat"a bas. Önizleme penceresinde yayını izleyebilirsin.' },
      { title: 'Kaydı durdur', text: 'Bitirmek istediğinde durdur. Kayıt Kayıtlar bölümüne düşer ve yayına hazır çıktısı otomatik üretilir.' },
      { title: 'Chat kliplerini dinle', text: '"Dinlemeye başla" ile sohbete düşen klip bağlantıları yakalanır; otomatik düzenleme açıksa hemen dikey videoya çevrilir.' },
    ],
    tips: ['"Şu ana kadarını kesmek için al" yayının başından şu ana kadarki kısmını indirir; Geçmiş yayınlar editöründe kesebilirsin.'],
  },
  nobet: {
    title: 'Nöbet nasıl kullanılır',
    intro: 'Nöbet, bilgisayar açık olduğu sürece takip ettiğin kanalı arka planda izler. Tarayıcıyı kapatabilirsin.',
    steps: [
      { title: 'Kanalı yaz', text: 'Takip edilecek kanalı gir. Kendi kanalın olmak zorunda değil.' },
      { title: 'Ne yapılacağını seç', text: 'Yayını baştan sona kaydetme, chat kliplerini yakalama, yakalananları otomatik düzenleme ve istersen otomatik paylaşma.' },
      { title: 'Nöbeti başlat', text: 'Kesit kanalı belirli aralıklarla yoklar. Yayın açıldığında günlükte görünür ve işler başlar.' },
      { title: 'Sonuçları topla', text: 'Yayın bitince kayıt kapanır, çıktı hazırlanır. Klipler Kütüphane\'de, kayıt Kayıtlar\'da, hepsi Arşiv\'de.' },
    ],
    tips: ['Bilgisayar uykuya geçerse nöbet de durur; uzun süre bırakacaksan uykuyu kapat.', 'Sunucu yeniden başlarsa açık nöbet kendiliğinden geri kurulur.'],
  },
  kayitlar: {
    title: 'Kayıtlar nasıl kullanılır',
    intro: 'Canlıdan ya da Nöbet\'ten alınan tam yayın kayıtlarını işlersin.',
    steps: [
      { title: 'Kaydı seç', text: 'Soldaki listeden bir kayıt seç; zaman çizelgesiyle açılır.' },
      { title: 'Yayına hazır çıktı', text: 'Kayıt bitince intro, outro ve logo eklenmiş, bit hızı ayarlanmış bir kopya üretilir. "Çıktıyı indir" ile al.' },
      { title: 'Kesit ya da kırpma', text: '"Kesitleri ayrı üret" işaretlediğin anları ayrı klip yapar. "Kayıttan çıkar" işaretlediğin kısımları atıp kalanını birleştirir.' },
      { title: 'YouTube\'a gönder', text: 'Zernio bağlıysa çıktıyı önce taslak olarak yükle, sonra "Yayınla".' },
    ],
    tips: ['Kayıt çıktısı ayarları (bit hızı, çözünürlük, logo) Marka ve şablon bölümünde.'],
  },
  paylasim: {
    title: 'Paylaşım nasıl kullanılır',
    intro: 'Kesit sosyal hesaplarına Zernio üzerinden gönderir. Zernio\'yu bir kez bağlarsın, sonra her klibi tek tıkla ya da planlı paylaşırsın.',
    steps: [
      { title: 'Zernio\'yu bağla', text: 'Sağdaki adımları izleyerek API anahtarını gir ve profilini seç.' },
      { title: 'Kütüphane\'den paylaş', text: 'Bir klip seç, "Paylaş"a bas, hesapları işaretle. Hemen gönderebilir ya da tarih/saat seçip planlayabilirsin.' },
      { title: 'Takip et', text: 'Planlananlar ve gönderilenler bu sayfada listelenir. Durumu yenilemek için satırdaki yenile düğmesine bas.' },
    ],
    tips: ['TikTok her gönderide önizleme ve onay ister; bu yüzden otomatik paylaşıma eklenemez.'],
  },
  arsiv: {
    title: 'Arşiv nasıl kullanılır',
    intro: 'Üretilen ve paylaşılan her şeyin günlük defteri. Dosyalar silinse bile kayıtları kalır.',
    steps: [
      { title: 'Güne göre bak', text: 'Üstteki ısı haritasında her kare bir gün; koyu renk o gün çok üretim olduğunu, alttaki yeşil çizgi paylaşım yapıldığını gösterir. Kareye tıklayıp o güne süz.' },
      { title: 'Ara ve süz', text: 'Başlık ya da kanal adıyla ara; yalnız klipleri, kayıtları ya da indirilen yayınları göster.' },
      { title: 'Geçmişi gör', text: 'Silinmiş içerik soluk görünür ve ne zaman silindiği yazar. Dosyası duranları "Aç" ile ilgili sayfada açabilirsin.' },
    ],
  },
  marka: {
    title: 'Marka ve şablon nasıl kullanılır',
    intro: 'Logo, intro, outro, renkler ve altyazı stilini bir kez ayarla; her klip ve kayıt bu kimlikle çıksın.',
    steps: [
      { title: 'Logo yükle', text: 'Şeffaf PNG en iyisi. Yükledikten sonra prototipte görünür.' },
      { title: 'Yerleştir', text: 'Yatay önizlemede logoyu sürükleyerek konumla; boyut ve opaklık kaydırıcılarıyla ayarla. Dikeyde dikiş ya da üst orta seçilir.' },
      { title: 'Intro ve outro', text: 'Kısa marka videolarını yükle; yatay kesitlerin ve kayıt çıktılarının başına ve sonuna eklenir.' },
      { title: 'Kaydet', text: 'Üretim varsayılanları kaynağa göre ayrı tutulur (Klipler, Geçmiş yayın, Canlı, Yatay kesit). Her birini seçip kaydet.' },
    ],
    tips: ['Kütüphane\'de hazır klip varsa önizleme gerçek bir kareyle gösterilir.'],
  },
  ayarlar: {
    title: 'Ayarlar',
    intro: 'Altyazı motoru, telefondan erişim ve verilerin nerede durduğu.',
    steps: [
      { title: 'Altyazıyı aç', text: 'İki yol var: bu bilgisayarda çalışan ücretsiz yerel modeli bir kez indir ya da ElevenLabs anahtarını bağla. Anahtar varsa önce o kullanılır.' },
      { title: 'Telefondan aç', text: 'Telefon ve bu bilgisayar aynı Wi-Fi\'daysa gösterilen adresi telefonun tarayıcısına yaz.' },
      { title: 'Verilerin yeri', text: 'Her şey bu bilgisayarda, gösterilen klasörde durur. Yedeklemek için o klasörü kopyalaman yeterli.' },
    ],
  },
} satisfies Record<string, Guide>;

export type GuideKey = keyof typeof GUIDES;
