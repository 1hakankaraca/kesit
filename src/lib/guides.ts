/** Sayfa rehberleri: her bölümün "nasıl kullanılır" içeriği, sade dille. */

export interface Guide {
  title: string;
  intro: string;
  steps: { title: string; text: string }[];
  tips?: string[];
}

export const GUIDES = {
  kutuphane: {
    title: 'Videolarım nasıl kullanılır',
    intro: 'Hazırlanan her dikey video ve yatay kesit burada. Solda liste, ortada izleme alanı, sağda ayrıntılar var.',
    steps: [
      { title: 'Video seç', text: 'Soldaki listeden bir videoya tıkla; ortada oynar. Üstteki seçeneklerle dikey/yatay ya da hazır/hazırlanan/hatalı olanları ayır.' },
      { title: 'İzle', text: 'Otomatik kontrol bir sorun bulursa sağda uyarı çıkar. Paylaşmadan önce baştan sona izle.' },
      { title: 'İndir ya da paylaş', text: '"İndir" tam kaliteyi verir; 1080p/720p/480p daha küçük bir kopya indirir. "Paylaş" sosyal hesaplarına gönderir. "Ekran görüntüsü" o anki kareyi kaydeder.' },
      { title: 'Temizle', text: 'İstemediğin videoyu sil. Video gider ama Arşiv\'de ne zaman hazırlandığı görünmeye devam eder.' },
    ],
    tips: ['Üstteki "Sadece <kanal> / Tüm kanallar" seçimiyle yalnız seçili kanalın videolarını görebilirsin.', 'İşin ne aşamada olduğunu sol menüdeki Görev yöneticisi\'nden izlersin.'],
  },
  klipler: {
    title: 'Kick klipleri nasıl kullanılır',
    intro: 'Bir kanalın Kick kliplerini getirip seçtiklerini kendiliğinden dikey videoya (telefon ekranı boyutunda) çevirirsin.',
    steps: [
      { title: 'Kanalı seç', text: 'Üst ortadaki kanal sekmelerinden birini seç ya da arama kutusuna kanal adı yaz.' },
      { title: 'Klipleri getir ve izle', text: 'Küçük resme tıklayınca klip oynar. Zaman aralığını ve sıralamayı üstten değiştirebilirsin.' },
      { title: 'Seç', text: 'Kartın alt kısmına ya da köşedeki yuvarlağa tıklayarak en fazla 20 klip seç.' },
      { title: 'Hazırla', text: 'Alttaki çubukta "Dikey klip üret"e bas. Yüz kamerası bulunur, kamera ve oyun alt alta dizilir, altyazı eklenir.' },
    ],
    tips: ['Tek bir klibin bağlantısı elindeyse sağdaki "Bağlantıdan ekle" kutusuna yapıştır.', 'Altyazı için Ayarlar\'da otomatik altyazı açık olmalı.'],
  },
  yayinlar: {
    title: 'Geçmiş yayınlar nasıl kullanılır',
    intro: 'Kick\'in sakladığı eski yayınları bilgisayarına indirip istediğin anları kesersin.',
    steps: [
      { title: 'Yayını indir', text: 'Aşağıdaki listeden bir yayın seç, "İndir"e bas. İndirme hızını ve kalan süreyi Görev yöneticisi\'nde görürsün.' },
      { title: 'Düzenle', text: 'İnen yayın üstte "Düzenlemeye hazır" kısmında kapak resmiyle görünür. "Düzenle" editörü açar.' },
      { title: 'Kesit işaretle', text: 'Editörde "Kesit seç" moduna geç (C tuşu) ve şeritte sürükle. Ya da oynatırken I (başlangıç) ve O (bitiş) tuşlarına basıp Enter\'la ekle.' },
      { title: 'Hazırla', text: 'Sağda dikey video ya da yatay kesit seç ve "Kesitleri üret"e bas. Sonuçlar Videolarım\'a düşer.' },
    ],
    tips: ['"İzle" modunda şeride tıklayınca ya da çizgiyi sürükleyince o ana gidersin.', '"Ekran görüntüsü" (S tuşu) o anki kareyi İndirilenler/Kesit klasörüne kaydeder.', 'İnen yayınlar 7 gün saklanır.'],
  },
  canli: {
    title: 'Canlı yayın nasıl kullanılır',
    intro: 'Süren bir yayını kaydeder, klipleri yakalar ve sohbete klip komutu atarsın. Sen yokken kendiliğinden olsun istiyorsan Otomatik takip\'i kullan.',
    steps: [
      { title: 'Kaydı başlat', text: '"Şimdiden" ya da geçmişten bir başlangıç seç ve "Kaydı başlat"a bas. Durdurunca kayıt Yayın kayıtları\'na düşer.' },
      { title: 'Klipleri dinle', text: '"Dinlemeye başla" ile hem sohbete atılan klipler hem de kanala Kick\'te eklenen yeni klipler yakalanıp indirilir. "Otomatik düzenle" açıksa dikey videoya da çevrilir.' },
      { title: 'Anlık klip al', text: 'Yayın sırasında 30–180 sn düğmelerinden birine bas: sohbete "!clip" yazılır. Kanalda klip botu varsa klip alınır ve yakalanır.' },
    ],
    tips: ['Anlık klip için Ayarlar\'da kendi Kick bağlantını kurman gerekir.'],
  },
  nobet: {
    title: 'Otomatik takip nasıl kullanılır',
    intro: 'Kesit açık ve bilgisayar uyanık olduğu sürece takip ettiğin kanalı arka planda izler. Tarayıcıyı kapatabilirsin.',
    steps: [
      { title: 'Kanalı yaz', text: 'Takip edilecek kanalı gir. Kendi kanalın olmak zorunda değil.' },
      { title: 'Ne yapılacağını seç', text: 'Yayın bitince yayını indirme, klipleri yakalama, yakalananları dikey videoya çevirme ve istersen kendiliğinden paylaşma.' },
      { title: 'Takibi başlat', text: 'Kesit kanalı birkaç dakikada bir kontrol eder. Yayın açılınca aşağıdaki günlükte görünür.' },
      { title: 'Sonuçları topla', text: 'Yayın bitince yayının tamamı indirilir, Geçmiş yayınlar\'da editörde seni bekler. Yakalanan klipler Videolarım\'da.' },
    ],
    tips: ['Bilgisayar uykuya geçerse takip de durur; uzun süre bırakacaksan uyku modunu kapat.'],
  },
  kayitlar: {
    title: 'Yayın kayıtları nasıl kullanılır',
    intro: 'Canlı yayın bölümünden aldığın tam kayıtları burada düzenlersin.',
    steps: [
      { title: 'Kaydı seç', text: 'Soldaki listeden bir kayıt seç; editör açılır.' },
      { title: 'Paylaşıma hazırla', text: '"Paylaşıma hazırla" açılış/kapanış videosunu ve logoyu ekleyip dosyayı küçültür. Sonra "Hazır videoyu indir".' },
      { title: 'Anları ayır ya da çıkar', text: '"Kesit seç" moduyla anları işaretle. "Kesitleri ayrı üret" her birini ayrı video yapar; "Kayıttan çıkar" o kısımları atıp kalanını birleştirir.' },
      { title: 'YouTube\'a gönder', text: 'Paylaşım bağlıysa hazır videoyu önce taslak olarak yükle, sonra "Yayınla".' },
    ],
    tips: ['Paylaşıma hazır kayıt ayarları (kalite, logo, açılış/kapanış) "Logo ve görünüm" bölümünde.'],
  },
  gorevler: {
    title: 'Görev yöneticisi',
    intro: 'İnen yayınlar, hazırlanan videolar ve son bir günde bitenler burada.',
    steps: [
      { title: 'Bölüm seç', text: 'İnenler, Hazırlananlar, Bitenler ya da Hatalılar arasında geç.' },
      { title: 'İlerlemeyi izle', text: 'İnen yayınlarda yüzde, inen boyut, hız ve kalan süre görünür. İstersen duraklat ya da iptal et.' },
      { title: 'Git', text: 'Biten işin yanındaki düğme seni ilgili yere götürür: videoyu gör, editöre git gibi.' },
    ],
    tips: ['Sol menüdeki sayı, şu an süren iş sayısıdır.'],
  },
  paylasim: {
    title: 'Paylaşım nasıl kullanılır',
    intro: 'Kesit videolarını sosyal hesaplarına Zernio adlı hizmet üzerinden gönderir. Bir kez bağlarsın, sonra tek tıkla ya da ileri bir tarihe paylaşırsın.',
    steps: [
      { title: 'Zernio\'yu bağla', text: 'Sağdaki adımları izleyerek anahtarını gir ve profilini seç.' },
      { title: 'Videolarım\'dan paylaş', text: 'Bir video seç, "Paylaş"a bas, hesapları işaretle. Hemen gönderebilir ya da tarih/saat seçebilirsin.' },
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
    intro: 'Logo, renk ve altyazı görünümünü bir kez ayarla. Dikey ve yatay videoların ayarları ayrıdır.',
    steps: [
      { title: 'Kimliğini ayarla', text: 'Sağda logoyu yükle (arka planı şeffaf PNG en iyisi), renklerini ve altyazı stilini seç; "Kimliği kaydet".' },
      { title: 'Biçimi seç', text: 'Dikey 9:16 ya da Yatay 16:9 sekmesini seç. Önizleme o biçimi gerçek oranlarıyla gösterir.' },
      { title: 'Yerleştir', text: 'Logoyu önizlemede sürükle; ortaya ve kenarlara gelince çizgi çıkar ve oraya oturur. Boyutunu ve görünürlüğünü kaydırıcılarla ayarla.' },
      { title: 'Kaydet', text: 'Her biçimin ayarını kendi düğmesiyle kaydet. Açılış ve kapanış videosu yalnız yatay videolara eklenir.' },
    ],
    tips: ['Yatay videolarda altyazı başta kapalıdır; istersen açarsın.'],
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
    tips: ['Telefondan açmak için "Telefondan erişim"i aç ve telefonda ekrandaki kodu gir.'],
  },
} satisfies Record<string, Guide>;

export type GuideKey = keyof typeof GUIDES;
