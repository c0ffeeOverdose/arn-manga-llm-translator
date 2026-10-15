# เอกสารสำหรับนักพัฒนา

[English](../README.md) | ภาษาไทย

> แปลจากฉบับอังกฤษ: 2026-10-15 · โค้ดอ้างอิง: `09dfec1`

สถาปัตยกรรม ระบบย่อย และขั้นตอนพัฒนา Arn Manga LLM Translator
วิธีติดตั้งและใช้งานอยู่ใน [README หลัก](../../README.md)

ใช้ฉบับอังกฤษเป็นหลัก เมื่อแก้เนื้อหาต้องปรับฉบับไทยตามหรือระบุว่ายังไม่ได้อัปเดต
ชื่อเทคนิค คำสั่ง และตัวอย่างใช้ตามโค้ดเดิม

## ลำดับการอ่าน

| บท | เนื้อหา |
| --- | --- |
| 1. [Architecture](architecture.md) | องค์ประกอบ ขอบเขตความรับผิดชอบ execution contexts และช่องทางสื่อสาร |
| 2. [Translation pipeline](translation-pipeline.md) | ไล่หนึ่งหน้าตั้งแต่คำสั่งของผู้ใช้จนเห็นข้อความแปล รวม cache hit และ cancellation |
| 3. [Reader integration](reader-integration.md) | หาและอ่าน img/canvas รักษาภาพต้นฉบับ รับมือ DOM เปลี่ยน และ Auto |
| 4. [Chapter translation](chapter-translation.md) | discovery, broker/runner, rolling slots, merged requests, Stop/Resume และการแนบผลกลับ reader |
| 5. [Inference และ model lifecycle](inference.md) | Koharu/CTD, panels, OCR, cleanup, WebGPU/WASM และ model storage |
| 6. [LLM, prompt และ context](llm-and-context.md) | รูปแบบข้อมูล provider adapters, retry, character book และความจำข้ามหน้า |
| 7. [Rendering และ geometry](rendering.md) | แยกขอบเขตข้อความ/บอลลูน/การลบ จัดลำดับอ่าน และวางข้อความภาษาไทย |
| 8. [Data, settings และ state](data-and-settings.md) | ที่เก็บข้อมูล cache identities, generations, settings snapshots และการกันผลลัพธ์เก่า |
| 9. [Cloud และ security boundaries](cloud-and-security.md) | API ฝั่ง Python การแปลงพิกัด ข้อมูลที่ส่งออก และข้อจำกัดด้านความปลอดภัย |
| 10. [Development และ troubleshooting](development.md) | setup, build, tests, debug และจุดเริ่มแก้ระบบแต่ละส่วน |

เริ่มจาก architecture และ pipeline แล้วเลือกบทตามระบบที่ต้องการแก้

## เอกสารเพิ่มเติม (อังกฤษ)

- [Translation controls (English)](../translation-controls.md): ขอบเขตของปุ่ม Translate, Stop, Resume และ settings
- [Translation cache (English)](../cache.md): cache policy, identity verification, transactions และ retention
- [CPU and memory ownership (English)](../performance.md): เจ้าของ bitmap/mask/model host และข้อจำกัดของตัวเลขหน่วยความจำ
- [KoharuLayout (English)](../koharu-layout.md): ไฟล์โมเดลที่รองรับ การ export และการติดตั้ง
- [Model mirror (English)](../model-mirror/README.md): ข้อมูลสำหรับเผยแพร่ runtime weights และ attribution
- [Server setup (English)](../../server/README.md): วิธีรัน endpoint เสริม
- [Contributing (English)](../../CONTRIBUTING.md), [Security policy (English)](../../SECURITY.md), [Privacy policy (English)](../../PRIVACY.md)

## คำศัพท์ที่ใช้ในเอกสาร

| คำ | ความหมายในโครงการนี้ |
| --- | --- |
| Reader | หน้าเว็บที่ผู้ใช้กำลังอ่าน ไม่ใช่หน้า options/popup ของ extension |
| PageRef | ตัวอ้างอิง `<img>` หรือ `<canvas>` ที่อ่าน/เขียนภาพได้ |
| Region / box | กลุ่มข้อความและกรอบพิกัด ไม่จำเป็นต้องเท่ากับพื้นที่บอลลูนทั้งใบ |
| Text mask | พิกเซลที่ detector ระบุว่าเป็นตัวอักษร ไม่ใช่คำสั่งให้ลบทั้งหมดทันที |
| Panel | ช่องภาพ ใช้ช่วยจัดลำดับอ่าน ไม่ใช่ text region |
| Inference host | iframe บน extension origin ที่รันโมเดลในเครื่อง แม้ชื่อไฟล์จะเป็น `worker.ts` แต่ entry นี้เป็น document |
| Chapter runner | document แยกจากแท็บอ่าน ทำงานทั้งบทและใช้ inference host อีกชั้นเมื่อจำเป็น |
| Checkpoint | งานระหว่างทางที่บันทึกไว้ เช่น detection/OCR ที่เสร็จแล้ว แต่ยังไม่ใช่คำแปลสมบูรณ์ |
| Artifact | ผลของ chapter run ที่มีภาพ render และข้อมูลประกอบสำหรับแนบกลับ reader |
| Fold | นำผลของหน้าเข้า context/book; เป็นศัพท์โค้ด ไม่ใช่ข้อความสำหรับแสดงผู้ใช้ |
| Generation / revision | ค่าที่ใช้บอกว่า recipe, run, page attempt หรือผล async ยังเป็นรุ่นที่มีสิทธิ์ใช้งานอยู่หรือไม่ |

## โค้ดและเวอร์ชันอ้างอิง

โค้ดอ้างอิง: 2026-10-15 · package 1.2.0 · revision `09dfec1`

เวอร์ชันจาก [package-lock.json](../../package-lock.json):

| Dependency | เวอร์ชัน |
| --- | --- |
| ONNX Runtime Web | 1.29.0 |
| Tesseract.js / core | 5.1.1 / 5.1.0 |
| TypeScript | 5.9.3 |
| esbuild | 0.24.2 |
| Playwright | 1.62.1 |
| fake-indexeddb | 6.2.5 |

CI ใช้ Node.js 22 ส่วน Python dependencies ใน `server/requirements.txt` ยัง pin เวอร์ชันไม่ครบ

ไดอะแกรมใช้ Mermaid ลูกศรแสดง data flow และ control flow

## วิธีดูแล docs เมื่อแก้โค้ด

1. แก้บทที่เกี่ยวข้อง และตรวจ defaults, cache recipes และ message contracts ที่เชื่อมกัน
2. แยกพฤติกรรมของโค้ด ผลทดสอบเฉพาะ environment และข้อเสนอออกจากกัน
3. อย่าใส่ API keys, URL/ชื่อ reader จริง หรือ identifiers จากเนื้อหาจริงลงตัวอย่าง
    ใช้ `reader.test`, `gallery.example.org` และข้อมูลสมมติแทน
4. อัปเดตฉบับไทยและวันที่ให้ตรงกับอังกฤษ หรือระบุว่ายังไม่ได้อัปเดต
   รักษาตัวอย่างโค้ดและไดอะแกรมให้ตรงกัน
