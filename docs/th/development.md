# Development และ troubleshooting

[English](../development.md) | ภาษาไทย

> แปลจากฉบับอังกฤษ: 2026-10-15 · โค้ดอ้างอิง: `09dfec1`

[สารบัญ](README.md) · [ก่อนหน้า: Cloud และ security](cloud-and-security.md)

## 1. Setup

ใช้ Node.js 22 ตาม [CI](../../.github/workflows/ci.yml) และ npm
โครงการใช้ strict TypeScript, ESM และ indentation 4 spaces
ดู [Contributing](../../CONTRIBUTING.md) และอ่าน `LESSONS.md` ก่อนแก้ subsystem

```bash
npm ci
node build.mjs
node build.mjs --firefox
```

`npm ci` ติดตั้งตาม committed lockfile ส่วน `models/` ไม่อยู่ใน version control
build ที่ไม่มี local weights อาจเตือนแต่ยังสำเร็จได้ และ Cloud-only workflow ไม่ต้องใช้ไฟล์เหล่านี้

โหลด build:

- Chromium: `chrome://extensions` → Developer mode → Load unpacked → `dist/`
- Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → manifest ใน `dist-firefox/`

หลัง rebuild ให้ reload extension และ reader แล้วตรวจ stamp `[mt] build`

## 2. Build graph

| Entry | Output / format |
| --- | --- |
| `src/content/content.ts` | `content.js`, IIFE/classic script |
| `src/background/background.ts` | `background.js`, ESM |
| `src/iframe/worker.ts` | `iframe/iframe-worker.js`, ESM; ORT runtime ไม่ bundle |
| `src/chapter/page.ts` | `chapter/page.js`, ESM; classic shim มาก่อน |
| `src/options/options.ts` | `options/options.js`, ESM |
| `src/popup/popup.ts` | `popup/popup.js`, ESM |

[build.mjs](../../build.mjs) clean target directory ก่อน build และ copy HTML, icons,
fonts, license notices, packaged ORT/Tesseract assets พร้อม optional dev weights
build Chromium กับ Firefox เป็นคนละคำสั่ง ไม่ใช่ `node build.mjs` ครั้งเดียวแล้วได้ทั้งสอง target

`npm run watch` / `--watch` เป็น one-shot build พร้อม inline sourcemap ใน bundles ที่กำหนด
ไม่ใช่ watcher ต้อง rebuild เองเมื่อ source เปลี่ยน

Firefox manifest ถูก derive จาก `src/manifest.json` เปลี่ยน service worker เป็น event page scripts
desktop minimum ใน build คือ 140, Android 142 ส่วน esbuild target เป็น `chrome120`
ต้องตรวจ runtime API และ model support แยกจาก compile target

## 3. Verification commands

```bash
# Required code checks
npx tsc --noEmit
npm test
node build.mjs
node build.mjs --firefox

# Focused examples
node --test "tests/cache-*.test.mjs"
node --test "tests/chapter-*.test.mjs"
node --test "tests/render*.test.mjs"

# Optional Python subsystem checks: requires its Python dependencies
python3 -m unittest discover -s server -p 'test_*.py'
```

ต้อง quote test glob แบบ package script เพื่อให้ Node 22 เป็นผู้ค้นหา
ถ้าต้องจำกัด concurrency ให้ option อยู่ **ก่อน glob**:

```bash
node --test --test-concurrency=1 "tests/**/*.test.mjs"
```

CI ลำดับ typecheck → Node tests → Chromium build → Firefox build → addons-linter 10
คำสั่ง CI สำหรับ lint:

```bash
npx --yes addons-linter@10 dist-firefox/ --self-hosted
```

คำสั่ง lint นี้อาจดาวน์โหลด tool เมื่อยังไม่มีใน environment
dev build ที่มี ONNX weights ใหญ่เกิน scanner ควร lint isolated model-free copy ของ code/assets เดียวกัน
หรือ release package ที่แยกไว้ ไม่ลบ weights จาก dev build ที่ใช้งานอยู่เพียงเพื่อให้ lint ผ่าน

unit tests ใช้ fake IndexedDB/inference fixtures ต้องตรวจ browser APIs,
การรันโมเดลและผลที่แสดงใน browser เพิ่มด้วย

## 4. เลือกจุดเริ่มแก้ตามงาน

| งาน | จุดเริ่ม | สิ่งที่ต้องตรวจตาม |
| --- | --- | --- |
| คำสั่ง Translate/Stop เลือกหน้าผิด | `content/commands.ts` | viewport, chapter ownership, popup state |
| อ่านภาพ/คืน original ไม่ได้ | `content/page-io.ts` | source precedence, blob/canvas, picture srcsets, screenshot permission |
| Auto แปลเกินขอบเขต | `content/auto.ts`, `auto-window.ts` | reading window, queued auto, lookahead cancellation |
| Chapter ค้าง/ข้ามหน้า | `chapter/page.ts`, `content/sweep.ts` | setup readiness, slots, leases, discovery และ attach |
| Session/tab แย่งงาน | `background/chapter-broker.ts` | active binding, lifecycle serialization, late publications |
| โมเดล/recipe ใหม่ | `iframe/worker.ts`, `layout-model.ts` | preprocessing, outputs, locks, model store, fingerprint |
| Prompt/provider ใหม่ | `llm/core.ts`, `adapters.ts` | payload mapping, retries, parser, usage, settings UI |
| ชื่อ/สรรพนามไม่ต่อเนื่อง | `llm/core.ts`, `chapter/context.ts` | scope, snapshot, contribution replacement, user edits |
| ลบ/วางข้อความผิดที่ | `render.ts`, `balloon-surface.ts`, `model-balloon.ts`, `inpaint.ts` | separate erase/layout geometry และ generation |
| Cache ไม่ hit/เสียเงินซ้ำ | `cache/policy.ts`, `identity.ts`, `store.ts`, `wire.ts` | source evidence, fp/dims/generation, transaction และ transport |
| Settings ไม่ตรงที่บันทึก | `options/model.ts`, `pipeline-section.ts`, `content/state.ts` | draft/save, defaults migration, async revisions, chapter stale |

## 5. Debug

เปิด Settings → Advanced → Troubleshooting → Debug mode
normal operation ยังแสดง progress/errors แต่ detailed logs/timing/model diagnostics บันทึกและแสดงเฉพาะ Debug
เปิดกลาง run เก็บได้เฉพาะเหตุการณ์หลังเปิด ไม่กู้สิ่งที่ไม่เคยบันทึก

### ตรวจ build และ context ก่อน

1. ตรวจ content `[mt] build`, extension manifest และ target ที่โหลด
2. แยก console ของ reader, background, inference document และ runner
3. Chromium offscreen ไม่ใช่ Playwright page ปกติ; ไม่อยู่ใน `context.pages()`
4. อ่าน chapter log จาก popup/extension IDB เมื่อเข้าถึง console ของ runner ไม่ได้
5. ใช้ `#mt-ui-text` สำหรับอ่าน pill text ซึ่งรับ state จาก activity registry

### หา stage ที่ช้า

[page-timing.ts](../../src/page-timing.ts) แยก read/cache/detect/OCR/payload/LLM/cleanup/render/encode/display
`[mt] page result` มี effective detector provider, layouts, boxes, cache reason และ generation
อย่าเรียกเวลารวมว่า model time หากรวม lock wait/network/encoding อยู่

chapter log แยก request receipt ระหว่าง caller/background/server
“sent แต่ไม่ received” มีสมมติฐานคนละแบบกับ “HTTP start แล้วไม่ reply”
และมีทั้ง **request cap** กับ **caller wait** ซึ่งต้องดูคู่กัน

## 6. Troubleshooting ตามอาการ

| อาการ | สิ่งที่ต้องตรวจ |
| --- | --- |
| 0/N และไม่มี inflight | runner setup/ready checkpoint และ storage bridge |
| Done แต่ยังเห็นต้นฉบับ | artifact และ attachment identity/signature/revision |
| ทุกหน้า RPC timeout | iframe lifecycle และ bounded GPU adapter response probe |
| WebGPU API มีแต่รันช้า | effective EP, adapter และ canvas pixel round-trip |
| Cache hit ยังทำงานนาน | source verification, font, cleanup, paint/PNG/display |
| กลับหน้าเดิมแล้วเรียก LLM ใหม่ | hash/fingerprint/dimensions/splitgen/identity และ broker transport error |
| Request 200 แต่ไม่มีคำแปล | raw text length, finish reason, usage/reasoning และ parse outcome |
| บาง region ไม่เปลี่ยน | keep/missing/unsafe placement และ actual glyph fit |
| Settings save บน Firefox ไม่ผ่าน | permission request ใน click task และ host pattern ที่ไม่มี port |
| RSS สูงหลังจบ | model sessions, decoded originals, native/GPU allocations และ idle deltas |

GPU health probe ถือว่า null/rejected adapter ยังเป็นการตอบกลับ
มีเพียงไม่ตอบในเวลาที่กำหนดหลัง inference timeout จึงยกระดับเป็น shared GPU fault
อย่าทำให้เครื่องที่ไม่มี WebGPU ถูกตีความว่า browser-wide hang

## 7. Browser และ E2E tests

- ใช้ isolated browser profile และ synthetic routed fixtures ไม่รบกวน session ที่ผู้ใช้กำลังอ่าน
- Chapter E2E ต้องชี้ mock endpoints ห้ามส่งคำขอไป provider จริง
- ยืนยัน build/manifest ที่กำลังรัน และ clear stale extension targets เมื่อต้อง reload
- ทดสอบ manual, Auto, chapter และ cache-hit แยกกันตามเส้นทางที่แก้ ไม่ใช้หน้าเดียวสรุปทุก workflow
- Stop ต้องทดสอบระหว่าง setup, OCR, LLM wait, merged fallback และก่อน attach เมื่อเกี่ยวข้อง
- Reader reload, SPA chapter switch, tab handoff/close และ source rendition swap เป็นคนละกรณี
- รอภาพ attach และ decode จริงก่อน screenshot ไม่ถ่ายเพียง progress complete
- Real model/GPU fixture ต้องไม่ไปรันแย่ง GPU ระหว่าง chapter ของผู้ใช้

local `eval/` และ `.test-local/` เป็น ignored tooling/artifacts ที่บางเครื่องอาจไม่มี
ไม่ใช่ส่วนหนึ่งของ public source checkout ที่ทุกคนต้องมีเพื่อรัน unit tests
ถ้ามี mock harness ใน environment ใช้ตามกติกา local ของโครงการ และอย่า commit profiles/keys/models

การ benchmark ต้องแยก cold/warm, headed/headless, effective provider, source pixels และ input recipe
ผลบน desktop ไม่ยืนยัน phone latency/VRAM และการมี GPU vendor ถูกต้องยังไม่ยืนยัน canvas pixels ถูกต้อง
อ่าน [Performance](../performance.md) ก่อนใช้ process RSS เป็น acceptance criterion

## 8. Release packaging

```bash
node build.mjs --release
node build.mjs --release --firefox
```

คำสั่งเหล่านี้สร้างหรือเขียนทับ release archives

- Version จาก package.json ต้องตรง tag `v<version>`
- Release marker ใช้ version+commit ไม่มี clock
- ไม่แพ็ก development ONNX model weights
- ตั้ง fixed mtimes และ `zip -X` เพื่อ byte-reproducible archives
- CI build สองรอบและเทียบ SHA-256 ก่อนแนบ artifacts
- ห้ามส่ง dev build ที่มี moving manifest version ขึ้น store

ไฟล์ source manifest ใช้ version เริ่มต้นของ build process จึงอย่าสรุปว่า release version เท่ากับเลข literal ใน manifest ต้นฉบับ
