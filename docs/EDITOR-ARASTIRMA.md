# Editör kullanılabilirlik araştırması (14 Ekim 2026)

Kesit editörünün CapCut / Premiere / Final Cut / DaVinci Cut / Clipchamp / Descript / Eklipse /
StreamLadder incelemesinden çıkarılan bulgular ve bunlardan türeyen kararlar. Kaynaklar sonda.

## 1. Yerleşim: dört bölge standart

Bütün masaüstü editörler aynı dört bölgeyi kullanıyor: **solda kaynak/araç paneli, ortada
oynatıcı, sağda özellik (inspector) paneli, altta zaman çizelgesi**. CapCut'ta sol panel
sekmelidir: İçe aktar · Ses · Yazı · Çıkartma · Efekt · Şablon. img.ly ekibinin bulgusu: tek bir
genel "Ekle" düğmesi yerine *işe özel* düğmeler (Yazı, Çıkartma…) editörün ne yapabildiğini
görünür kılıyor; gizli özellik keşfedilmiyor.

**Karar:** Sol panel sekmeli olacak: **Medya · Ses · Yazı · Düzen · Marka**. "Düzen" sekmesi
yayıncı araçlarındaki (Eklipse, StreamLadder) hazır dikey yerleşim şablonlarını taşır
(kamera üstte/ekran altta, kamera köşede, tam ekran, yan yana). "Yazı" sekmesi hazır yazı
kalıpları sunar (başlık, alt yazı şeridi, isim etiketi, çağrı).

## 2. Zaman çizelgesi araç çubuğu çizelgenin üstünde

CapCut, Clipchamp ve Filmora araçları (böl, sil, sol/sağ at, dondur, hız, yapış, yakınlaştır)
zaman çizelgesinin hemen üstündeki şeride koyar; oynatıcının altında yalnız oynatma denetimleri
kalır. Kesit'te araçlar oynatıcının altındaydı ve zaman çizelgesinden uzaktı.

**Karar:** Araç çubuğu zaman çizelgesinin üst şeridine taşınır (geri/ileri · böl · başını at ·
sonunu at · çoğalt · sil · sil+kaydır · sessize al · mıknatıs · yapış · yakınlaştır). Oynatıcı
altında yalnız başa dön / oynat / zaman / güvenli alan / sığdır.

## 3. Boşluk ve senkron: yeni başlayanın en sık hatası

Final Cut'ın mıknatıslı zaman çizelgesi, Filmora'nın "auto ripple"ı ve Clipchamp'in
"snapping kapalıyken boşluk oluşur" uyarısı aynı noktayı gösteriyor: yol tabanlı serbest
yerleşimde **boşluk kalması ve sesin görüntüden kayması** en yaygın hata. Final Cut'ın çözümü:
ana hikâye şeridinde parçalar birbirine yapışık durur; ekleme/silme/kısaltma komşuları
kendiliğinden kaydırır; bağlı parçalar (yazı, ses) ana parçayla birlikte taşınır.

**Karar:** **"Mıknatıs" modu varsayılan açık.** Ana görüntü yolunda (Video 1) parçalar her
zaman art arda durur: silme boşluk bırakmaz, kısaltma sonrakileri çeker, sürükleme sıra
değiştirir. Üst katmanlar (yazı, logo, kamera) serbest kalır. Mıknatıs kapatılabilir.

## 4. Yapışma ve kısaltma geri bildirimi

img.ly'nin ölçülmüş dersleri:
- Yapışma hedefleri: diğer parçaların kenarları, oynatma çizgisi, çizelgenin başı/sonu — ama
  **yalnız görünür alandakiler** (ekran dışı hedefler kullanıcıyı şaşırtıyor).
- Yapışınca noktalı kılavuz çizgisi görünür.
- Tutamakların dokunma alanı görünen genişliğinin iki katından fazla olmalı.
- Parça kaynağın sonuna dayanınca tutamak şekli değişir ("daha fazla uzamaz").
- Seçili parçada süre etiketi (10 sn altında bir ondalık: 4,2 sn).
- Kısaltırken oynatma çizgisi yerinden oynamaz; yeni kenar zamanı ayrı bir baloncukta gösterilir.

**Karar:** Hepsi uygulanır: görünür alana sınırlı yapışma, kılavuz çizgisi, geniş tutamaklar,
sınırda tutamak rengi, seçili parça süre rozeti, kısaltma baloncuğu.

## 5. Klavye ve sağ tık

CapCut'ta tutarlı kısayollar: **Ctrl/Cmd+B böl**, **Q/W oynatma çizgisinin solunu/sağını at**,
**Backspace/Delete sil**, Ctrl+R hız. Filmora ve CapCut sağ tık menüsü: böl, sil, hız, dondur,
sessize al, kopyala/yapıştır.

**Karar:** Kısayollar: Boşluk oynat · S / ⌘B böl · Q başını at · W sonunu at · Sil · ⇧Sil
sil+kaydır · ⌘D çoğalt · ⌘C/⌘V kopyala-yapıştır · ⌘Z/⇧⌘Z · ← → kare · ⇧← → 1 sn · M sessize al ·
? kısayol listesi. Parçada sağ tık menüsü aynı komutları sunar.

## 6. Dikey video güvenli alanı

TikTok/Reels/Shorts için resmi ölçü yok; topluluk ölçümleri uyuşmuyor. Ortak nokta: 1080×1920'de
yüzler, yazı ve logo yaklaşık **900×1490 merkez dikdörtgen** içinde kalmalı; altta ~350–500 px
(açıklama + düğme yığını), üstte ~130–250 px, yanlarda ~60 px risklidir. Altyazı için MarginV≈350.

**Karar:** Oynatıcıda "Güvenli alan" düğmesi: dikeyde üst 250 / alt 420 / yan 60 px'lik
yarı saydam bölgeler + merkez çerçeve çizilir. Yazı kalıpları güvenli alana oturur.

## 7. Boş durum ve ilk kullanım

Clipchamp Timeline 2.0 boş çizelgeye "nereden başlanır" yönlendirmesi, ilk medya bırakıldıktan
sonra yazı/ses için yer gösteren rehberler ekledi. Unity tasarım sistemi: boş durum yalnız mesaj
değil, **bir sonraki adımı** vermeli. Adobe Firefly: ilk eylem tek vurgulu düğme.

**Karar:** Boş çizelge büyük bir bırakma alanı ("Dosyayı buraya sürükle ya da soldan ekle");
ilk parçadan sonra tek seferlik ipucu şeridi (Yazı/Ses sekmeleri, S ile böl); proje ilk
açılışta 3 adımlı kısa rehber kartı.

## 8. Yayıncı araçlarının öne çıkardığı özellikler

Eklipse / StreamLadder / OpusClip: yüz kamerası takibi, **hazır dikey düzen şablonları**, tek
tıkla altyazı (yazı tipi/renk/kontur/arka plan), doğrudan paylaşım, hız ve dondurma, geçişler.
Descript: metinden kurgu — döküm satırına tıklayınca o ana gitmek en ucuz kazanım.

**Karar:** Düzen şablonları (madde 1), altyazı satırına tıklayınca o ana gitme, **hız**
(0,25–4×) ve **giriş/çıkış yumuşatma (fade)**; dondurma ve geçişler sonraki adım.

## 9. Uygulanan değişiklikler (özet)

| Alan | Önce | Sonra |
| --- | --- | --- |
| Sol panel | Düğme ızgarası + dosya listesi | Sekmeler: Medya · Ses · Yazı · Düzen · Marka; dosyada üstüne gelince "+ Ekle" |
| Araçlar | Oynatıcının altında | Zaman çizelgesi araç şeridi; oynatıcı altı sade |
| Boşluklar | Elle "Boşlukları kapat" | Mıknatıs modu (ana yol hep yapışık), kapatılabilir |
| Yapışma | Tüm parçalar | Görünür alan + kılavuz çizgisi + süre rozeti + kısaltma baloncuğu |
| Kısayollar | Boşluk, S, Sil, ⌘Z, ⌘D | + ⌘B, Q, W, ⌘C/⌘V, M, ⇧ok, ? listesi; sağ tık menüsü |
| Dikey | — | Güvenli alan göstergesi; düzen şablonları |
| Parça | Konum, kırpma, renk, ses, yazı, altyazı | + hız, giriş/çıkış yumuşatma; altyazı satırı → o ana git |
| İlk kullanım | Boş siyah sahne | Bırakma alanı, ipucu şeridi, 3 adımlı rehber |

## Kaynaklar

- CapCut arayüzü: [websiteseostats.com](https://websiteseostats.com/capcut-ui-a-complete-guide-to-the-capcut-user-interface-editing-timeline-tools-panels-templates-and-creative-workflow/), [primalvideo.com](https://primalvideo.com/guides/capcut-for-pc-mac-tutorial/), [filmora – CapCut timeline](https://filmora.wondershare.com/advanced-video-editing/capcut-timeline.html), [techpp – CapCut ikonları](https://techpp.com/2025/05/27/capcut-desktop-icons-symbols-meaning/)
- CapCut kısayolları: [shortcut-tools.com](https://shortcut-tools.com/en/shortcuts/capcut/), [sheetly.org](https://sheetly.org/cheatsheets/capcut), [tutorialtactic.com](https://tutorialtactic.com/blog/capcut-shortcuts/)
- Zaman çizelgesi etkileşimi: [img.ly – Designing a timeline for mobile video editing](https://img.ly/blog/designing-a-timeline-for-mobile-video-editing/), [Clueso – Ripple edit](https://www.clueso.io/glossary/ripple-edit), [Filmora – Auto ripple](https://filmora.wondershare.com/basic-video-editing/auto-ripple-filmora.html), [Filmora – Magnetic timeline](https://filmora.wondershare.com/advanced-video-editing/filmora-magnetic-timeline.html), [OpenShot – Clips](https://www.openshot.org/static/files/user-guide/clips.html)
- Final Cut mıknatıslı çizelge: [Apple – Magnetic Timeline](https://support.apple.com/guide/final-cut-pro-ipad/devd9b6a5715/ipados), [Frame.io](https://blog.frame.io/2017/10/16/fcpx-magnetic-timeline/), [vagon.io karşılaştırma](https://vagon.io/blog/final-cut-pro-vs-premiere-pro-comparison-guide), [ituonline](https://www.ituonline.com/blogs/which-is-easier-adobe-premiere-or-final-cut-pro/)
- DaVinci Cut sayfası: [Blackmagic – Cut](https://www.blackmagicdesign.com/products/davinciresolve/cut), [Cut vs Edit](https://davinciresolve21.com/blog/davinci-resolve-cut-page-vs-edit-page-differences), [OWC – B-roll](https://www.owc.com/blog/how-to-edit-b-roll-and-stock-faster-with-davinci-resolves-cut-page)
- Clipchamp / Canva / Descript: [Clipchamp Timeline 2.0](https://clipchamp.com/en/blog/timeline-2_0), [aiarty – Clipchamp](https://www.aiarty.com/edit-video/clipchamp-review.htm), [bityclips – Clipchamp](https://bityclips.com/blog/clipchamp-review-2026), [prodshort – beginners](https://prodshort.com/blog/best-video-editing-for-beginners), [ngram – Descript alternatives](https://www.ngram.com/blog/top-7-ai-video-creator-alternatives-to-descript-in-2026-reviewed-and-compared)
- Boş durum / ilk kullanım: [Unity design system – empty states](https://unityeditordesignsystem.unity.com/patterns/empty-states), [Adobe Firefly – create a timeline](https://helpx.adobe.com/firefly/web/firefly-video-editor/set-up-your-project/create-a-timeline-in-a-project.html)
- Güvenli alan: [syllaby.io](https://syllaby.io/blog/aspect-ratios-safe-zones-shorts-reels-tiktok/), [kreatli – TikTok](https://kreatli.com/guides/tiktok-safe-zone), [adaptlypost](https://adaptlypost.com/blog/social-media-safe-zones-2026-complete-guide), [daohuy – altyazı](https://daohuy.com/en/blog/post-vertical-subtitle-safe-zones-9-16/)
- Yayıncı araçları: [Eklipse – features](https://eklipse.gg/features/), [Eklipse – Kick clips](https://eklipse.gg/features/kick-clips/), [Eklipse vs OpusClip](https://eklipse.gg/compare/eklipse-as-opusclip-alternative/), [StreamLadder](https://streamladder.com/), [streamgen – AI clipping tools](https://streamgen.cc/blog/best-ai-clipping-tool/)
