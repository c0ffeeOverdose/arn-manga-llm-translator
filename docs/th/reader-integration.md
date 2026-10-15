# Reader integration และ Auto

[English](../reader-integration.md) | ภาษาไทย

> แปลจากฉบับอังกฤษ: 2026-10-15 · โค้ดอ้างอิง: `09dfec1`

[สารบัญ](README.md) · [ก่อนหน้า: Translation pipeline](translation-pipeline.md) · [ถัดไป: Chapter translation](chapter-translation.md)

## 1. รูปแบบหน้า

extension รองรับ image column, horizontal spread, single-image page turn,
virtualized canvas, lazy loading และ blob URLs โดยตรวจจากกลไกของ reader
แทนการ hardcode รายชื่อเว็บใน pipeline

[PageRef](../../src/content/state.ts) แบ่งเพียงสองชนิด:

```ts
type PageRef =
    | { kind: 'img'; el: HTMLImageElement }
    | { kind: 'canvas'; el: HTMLCanvasElement; key: string; pageSrc?: string };
```

`pageSrc` ของ canvas เป็น original source ที่หาได้จาก manifest หากมี
ส่วน `key` ช่วยระบุ canvas ที่ไม่ได้มี URL แบบ img

## 2. หา candidate pages

`getPages` ใน [page-io.ts](../../src/content/page-io.ts) เลือก element ที่มีขนาด/บริบทเหมาะกับภาพอ่าน
และตัด UI/ภาพที่ประกาศ skip ออก ไม่ถือว่า `<img>` ทุกอันคือมังงะ
การเลือกหน้าปัจจุบันใช้สัดส่วนที่ทับ viewport ไม่ใช่ DOM order อย่างเดียว

สำหรับ chapter/off-DOM prefetch ยังมีแหล่งข้อมูลอีกหลายแบบ:

| แหล่งข้อมูล | ใช้เมื่อ | ข้อจำกัด |
| --- | --- | --- |
| Episode/canvas manifest | reader ประกาศลำดับภาพไว้ | อาจมีช่องที่ยังไม่มี source/pixels |
| Paged chapter API | API ส่ง file list ทั้งบท | ต้องรักษา page order และ alternate encoding ต่อหน้า |
| Embedded gallery manifest | DOM แสดงแค่หน้าปัจจุบัน | ต้องจับ anchor ให้ตรงกับภาพที่ผู้ใช้อยู่ |
| Hash-file manifest + routing data | ภาพแบ่ง CDN shard/build | parse เป็นข้อมูล ไม่ execute remote script |
| DOM และ lazy-image attributes | ไม่มี manifest ที่ใช้ได้ | ไม่รับประกันว่าเห็นทุกหน้าทั้งบทแล้ว |
| Same-chapter document discovery | pagination มีหน้าถัดไป | ห้ามข้าม origin/chapter และต้องหยุดเมื่อซ้ำ/จบ |

helpers ของรูปแบบเหล่านี้อยู่ใน [page-cache.ts](../../src/content/page-cache.ts)
และ [chapter/discovery.ts](../../src/chapter/discovery.ts)
MangaDex เป็น integration ที่มี API/host gate โดยตรง ส่วน adaptations อื่นตั้งชื่อตามกลไกทั่วไป

## 3. อ่านภาพ: original pixels มาก่อนเสมอ

`readPage` ไม่ใช่ `fetch(img.src)` แบบตรง ๆ เพราะ `src` อาจเป็นผลแปลของเราเองหรือ blob ที่ถูก revoke แล้ว

### Image reader

1. หากมี extension-owned original copy ที่ตรงกับ state ปัจจุบัน ใช้สำเนานั้น
2. ถ้าเป็น original blob ที่ element ยังแสดงอยู่ ลอง decode จาก element ซึ่งอาจยังมี pixels แม้ URL ถูก revoke
3. URL ปกติใช้ `fetchBitmap`: direct fetch → background proxy → bounded hotlink retry เมื่อเข้าเงื่อนไข
4. หากอ่านไม่ได้ จึงลอง screenshot เป็นทางสุดท้ายเมื่อมีสิทธิ์และแท็บมองเห็นอยู่

เมื่อ element ไม่ได้แสดง original blob แล้ว ห้าม decode ภาพปัจจุบันแทน
หากต้นฉบับหมดอายุและไม่มีสำเนา ต้อง fail พร้อม `noScreenshot` เพื่อไม่ถ่ายคำแปลของตัวเองกลับมาทำ OCR

### Canvas reader

1. Re-translate ใช้ original bytes ที่ stash ไว้ เมื่อ identity ยืนยันว่า canvas ยังเป็นหน้าเดิม
2. หากมี manifest source ให้ fetch และลอง `unscrambleTiles` โดยผ่าน discontinuity gate
3. มิฉะนั้นอ่าน `toDataURL` จาก canvas; หาก tainted จึงพิจารณา screenshot
4. canvas placeholder ที่ยัง uniform/blank ไม่สร้างคำแปลหรือ cache ที่ทำให้เข้าใจผิดว่าเสร็จแล้ว

`unscrambleTiles` เป็น deterministic tile mapping ที่จะรับผลเฉพาะเมื่อรอยต่อภาพดีขึ้นตาม gate
ไม่ใช่ตัวแก้ permutation ทั่วไปของทุก reader

### สิทธิ์สำหรับ screenshot

ต้องใช้ `activeTab` จาก user gesture และ background ตรวจว่า sender เป็น active tab ของ window ที่จะ capture
content ต้องไม่อยู่ใน hidden document และ crop ตาม device pixel ratio
ภาพมีเฉพาะ pixels ที่มองเห็น อาจไม่ใช่ source เต็มความละเอียด และใช้กับ Auto ไม่ได้ทุกกรณี

ใน `readPage` ต้องใช้ `return await fetchBitmap(...)` ภายใน try/catch
bare `return` จะส่ง rejected promise ออกไปโดยข้าม catch ที่เตรียม screenshot fallback

## 4. เขียนภาพกลับผ่าน single writer

`writePage` เป็นจุดเขียนผลกลับ reader:

- img: เปลี่ยน `src` ตาม translated/original/debug choice และผูก element กับ state
- `<picture>`: stash แล้ว clear sibling `<source srcset>` มิฉะนั้น browser อาจเลือก source เดิมแทน `img.src`
- Show original: restore srcsets และใช้ original-owned copy หากต้นฉบับเป็น blob ที่หมดอายุ
- canvas: draw bitmap กลับบน canvas เดิม มี guards ก่อนและหลัง async decode เพื่อไม่วาดทับหน้าใหม่หรือ choice ใหม่

[overlays.ts](../../src/content/overlays.ts) แทน pixels ใน element เดิม
และตรวจซ้ำเป็นระยะเพื่อวาดผลกลับเมื่อ reader เปลี่ยน element หรือ redraw

## 5. Identity หลายระดับ

| Identity | ตอบคำถามอะไร | ไม่ได้พิสูจน์อะไร |
| --- | --- | --- |
| URL/path | reader ประกาศ source นี้หรือไม่ | CDN host/encoding เปลี่ยนได้; URL เดิมอาจส่งภาพใหม่ |
| DOM element binding | element นี้เคยแสดง state ใด | virtualizer อาจ recycle element สำหรับอีกหน้า |
| 48×48 content hash | pixels ที่ decode สอดคล้องกับ rendition เดิมหรือไม่ | ไม่ใช่ cryptographic proof หรือ chapter page number |
| ImageIdentity / region evidence | rendition ที่ต่างขนาด/encoding ยังเป็นเนื้อหาเดียวกันหรือไม่ | dimensions เท่ากันเพียงอย่างเดียวไม่พอ |
| Page order จาก manifest | ลำดับ logical page | ไม่อนุญาตให้วาด artifact โดยไม่ยืนยันภาพปัจจุบัน |

`pages`, `elStates`, `hashStates` ใน [state.ts](../../src/content/state.ts)
และ [page-identity.ts](../../src/content/page-identity.ts) ช่วย reuse state เมื่อ URL/element เปลี่ยน
unknown source ต้อง verify ก่อนสร้าง alias ถ้า reader recycle element เป็นอีกภาพต้องปล่อย binding เก่า

ภาพต้นฉบับที่ extension ทำสำเนาเองมี pixel-size cap สำหรับ blob reader
จึงไม่รับประกันว่าจะคืน original ของ giant strip ที่ blob หมดอายุได้ทุกกรณี

## 6. ขอบเขตการแปลของ Auto

[auto.ts](../../src/content/auto.ts) ประเมินหน้าที่มองเห็นและ `prefetchN` หน้าข้างหน้า:

1. ตรวจ per-site setting และ halt state ก่อนเริ่มงาน
2. เลือก visible spread + pages ahead ผ่าน [auto-window.ts](../../src/content/auto-window.ts)
3. เอา queued Auto jobs ที่หลุดหน้าต่างอ่านออก โดยไม่ล้าง manual intent
4. enqueue หน้าที่ยังไม่แปลและไม่ถูก chapter/paint owner ถืออยู่
5. เมื่อ mounted window หมดแล้วจึงลอง manifest-based off-DOM lookahead

ขอบเขตเลื่อนตามตำแหน่งที่อ่าน ไม่ขยายเองเมื่อแปลเสร็จ
เมื่อ chapter runner active, Auto หลีกทางเพื่อไม่ส่งคำขอแปลซ้ำ

off-DOM lookahead ไม่มี element จึงไม่ paint ทันที ผลลง translation cache และ context
เมื่อ reader แสดงหน้านั้นค่อยผ่าน cache/arrival-render path อีกครั้ง
ต้องมี manifest source ที่อ่านได้ ไม่ได้เลื่อนเว็บแทนผู้ใช้เพื่อสร้าง DOM ไปเรื่อย ๆ

## 7. Pause, cooldown และ stale work

- ปิด Auto: หยุด queued Auto และ lookahead; manual/in-flight page บางส่วนมีขอบเขตของตัวเอง
- Stop all: revoke active/queued work และ pause Auto ของแท็บนั้น แต่ไม่ลบหน้าที่แปลเสร็จ
- Auth/429 และ shared inference fault: halt fan-out รอ intent ที่ชัดเจน ไม่ retry 429 เป็น loop
- Page-level failures มี cooldown/attempt bound ไม่ enqueue ใหม่ทุก tick
- Auto ทิ้งงานที่ element หายหรือเปลี่ยนภาพแล้ว ก่อนส่งคำขอแปล
- SPA chapter change ต้อง reset chapter context, revoke งานเก่า และไม่ reuse state จากเรื่องอื่น

เพื่อไม่ให้ late async result ฟื้น UI เก่า consumer ใช้ revision/generation guards
การตรวจ URL ตอนเริ่มงานอย่างเดียวไม่พอ เพราะระหว่าง OCR/network wait ผู้ใช้อาจเปลี่ยนหน้าไปแล้ว

## 8. เมื่อเพิ่ม reader adaptation

1. ระบุกลไกที่ต่าง: manifest, canvas, blob lifecycle, pagination หรือ routing
2. เพิ่ม pure parser/identity rule พร้อม fixture โดเมนสมมติ
3. ตรวจทั้ง manual, Auto, chapter discovery และ attach ถ้าใช้กลไกร่วมกัน
4. รักษา original source precedence, `writePage` single writer และ chapter boundary
5. ห้ามอาศัยชื่อเรื่อง ภาษา หรือชื่อเว็บจริงเพื่อปรับ pipeline เฉพาะกรณี

tests เริ่มต้น: [page-io](../../tests/page-io.test.mjs), [image-identity](../../tests/image-identity.test.mjs),
[reader-start](../../tests/reader-start.test.mjs), [hash-reader-source](../../tests/hash-reader-source.test.mjs),
[hash-reader-manifest](../../tests/hash-reader-manifest.test.mjs) และ [ux-flow](../../tests/ux-flow.test.mjs)
