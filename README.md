# Travel Memo

Clean production repository package.

## Deploy settings for Vercel

- Framework Preset: Vite
- Install Command: npm ci
- Build Command: npm run build
- Output Directory: dist
- Node.js Version: 20.x

## Local check

```bash
npm ci
npm run check
npm run build
```

## After deploy

Open `/reset-cache.html` once to refresh app cache.

## Latest update note

รายละเอียดอัปเดตล่าสุดถูกรวมไว้ในส่วน `Update Log` ของไฟล์นี้แล้ว เพื่อให้หน้า GitHub แสดงข้อมูลเวอร์ชันล่าสุดโดยไม่ต้องมีไฟล์ note แยก

## Update Log

### v2.8.7 — Public Share Polish
- Improved Public Trip social metadata with Open Graph/Twitter fallback tags, canonical URL, preview image fallback, and better read-only public story descriptions.
- Polished the Public Trip page for mobile readability and added a compact public Map Points section.
- Added Admin Public Share Inspector for active public links, copied public URLs, and quick opening of public pages.
- Simplified Public Trip controls to the core open/close Public Link workflow.
- Added migration `023_public_share_polish_admin_tools.sql` for public share policy/index alignment.
- Updated app/cache version to `2.8.7` / `travel-memo-v2-8-7`.

### v2.8.5 — Public Share Reopen + Story Polish
- Fixed public Trip links so the same slug/link can work again after an owner disables and re-enables Public sharing.
- Added `supabase/migrations/022_public_share_reopen_policy_alignment.sql` to align public read policies around `is_public=true` and `public_slug`, while keeping private Trips hidden with `is_public=false`.
- Improved the Public Trip page into a read-only story experience with a stronger hero, overview stats, grouped day timeline, richer chapter cards, inline photo strips, and cleaner photo highlights.
- Improved public share error copy for stale schema/RLS situations after reopening public links.
- Updated app/cache version to `2.8.5` / `travel-memo-v2-8-5`.

### v2.8.3 — Deploy Lockfile Fix
- Fixed Vercel deploy failure caused by an invalid `tslib@2.8.2` lockfile entry.
- Pinned transitive Supabase `tslib` resolution in `package-lock.json` to the valid `tslib@2.8.1` package.
- No changes to Google OAuth/Login or public share runtime behavior.
- Updated app/cache version to `2.8.3` / `travel-memo-v2-8-3`.


### v2.7.9 — Production Polish + Bug Sweep
- เก็บรอบเสถียรหลังใช้งานจริง: ปรับ UI/UX หลักโดยไม่เพิ่มฟีเจอร์ใหญ่
- ปรับ Save / Sync feedback ให้ชัดขึ้น: ปุ่มไม่หายไอคอนระหว่างทำงาน, sync status แยกสถานะ ready/pending/syncing/offline/error และแสดงสถานะบนหน้า Home/Profile ชัดขึ้น
- ปรับ Photo Upload UX: เพิ่มแถบสถานะเตรียมรูป/ย่อรูป/เพิ่มรูปสำเร็จ พร้อม progress และข้อความกรณีข้ามไฟล์หรือพบ GPS
- ปรับ Map UX: เพิ่มข้อความบอกเหตุผลเมื่อ Trip มีจุดเดียวหรือไม่มีพิกัด ทำให้ Route Replay เข้าใจง่ายขึ้น และปรับปุ่ม replay ให้มีไอคอน/ข้อความสม่ำเสมอ
- ปรับ Admin / Diagnostics เป็น health dashboard มากขึ้น: เพิ่ม Production Health summary, health strip ใน Diagnostics และแยกรายละเอียดเทคนิคไว้ใน section ที่อ่านง่าย
- อัปเดต version/cache เป็น `2.7.9` / `travel-memo-v2-7-9`

### v2.7.9 — Photo Location Detail
- ปรับปุ่มปักหมุด GPS บนรูปให้เป็นปุ่มเดี่ยวขนาดเท่าปุ่มจัดลำดับรูป และแยก badge `GPS` เป็นปุ่มของตัวเองโดยไม่มีกรอบรวมสีเขียว
- เพิ่ม Photo Location Detail ใน Memo Reading Mode สำหรับรูปที่มี GPS พร้อม mini map preview, source, ระยะห่างจากพิกัด Memo และปุ่มดูรูปบนแผนที่
- เพิ่ม photo-level markers บนหน้า Map เพื่อดูตำแหน่งของรูปแต่ละใบ ไม่ใช่เฉพาะ Memo marker
- เพิ่มตัวเลือก Photo route เมื่อเลือก Trip เพื่อวาดเส้นทางจากพิกัดรูปทุกใบแบบเส้นประสีส้ม แยกจาก route line ของ Memo
- เพิ่มการวิเคราะห์รูปใน Memo เดียวที่ถ่ายคนละตำแหน่งหลายจุด พร้อมคำแนะนำให้แยก Memo หากเหมาะสม
- เพิ่ม note เรื่อง reverse geocoding: ยังปิดไว้เป็นค่าเริ่มต้น และควรทำเป็น optional provider ในอนาคต เช่น Nominatim/MapTiler/Custom endpoint เพื่อไม่ผูกต้นทุนกับระบบหลัก
- อัปเดต version/cache เป็น `2.7.9` / `travel-memo-v2-7-9`


### v2.7.9 — Photo GPS Badge Compact Polish
- ปรับปุ่ม `ใช้พิกัดนี้กับ Memo` บนการ์ดรูปให้เหลือเป็นไอคอนปักหมุดที่มุมซ้ายบนของรูป
- ย้าย badge `GPS` ไปอยู่ข้างไอคอนปักหมุดบนรูป
- ซ่อนข้อความระยะทางเช่น `ใกล้พิกัด Memo 0 ม.` เพื่อลดความรกของการ์ดรูป
- คง tooltip/aria label ไว้ให้รู้ว่าปุ่มปักหมุดคือการใช้พิกัดจากรูปกับ Memo
- อัปเดต version/cache เป็น `2.7.9` / `travel-memo-v2-7-9`


### v2.7.9 — Location Repair Tools
- เพิ่มเครื่องมือ Location Repair ใน Admin Dashboard สำหรับตรวจ Memo ที่ไม่มีพิกัดและเติมพิกัดจากรูปที่มี EXIF GPS
- เพิ่มปุ่ม Repair GPS และ Copy Location report ใน Admin Quick Tools
- เพิ่ม Location Repair card แสดงจำนวน Memo ที่มีพิกัด, ไม่มีพิกัด, รูปที่มี GPS และรายการที่ซ่อมได้
- เพิ่ม Location Data ใน System Health และ Diagnostics เพื่อดูคุณภาพข้อมูลพิกัดได้ชัดขึ้น
- เพิ่ม Map Location Quality indicator ในหน้า Map Summary
- การซ่อมพิกัดจะทำเฉพาะ Memo ของบัญชีปัจจุบันและไม่แก้ shared/read-only records โดยตรง
- อัปเดต version/cache เป็น `2.7.9` / `travel-memo-v2-7-9`


### v2.7.2 — Route Replay / Trip Path
- เพิ่ม Route Replay ในหน้า Map เมื่อเลือก Trip ที่มี Memo พร้อมพิกัดอย่างน้อย 2 จุด
- เพิ่มปุ่มเล่น/พัก/ก่อนหน้า/ถัดไป/เริ่มใหม่ เพื่อไล่ดูเส้นทางตามลำดับวันและเวลา Memo
- Highlight จุดปัจจุบันบนแผนที่และใน Memo list ระหว่าง replay
- เปิด popup ของ Memo ระหว่าง replay เพื่ออ่านบริบทของแต่ละจุด
- คง Route line เดิมไว้ และใช้ร่วมกับ Replay controls
- ปรับ UI Route Replay ให้กระชับบนมือถือ


### v2.7.1 — Map UI Polish
- ปรับสีตัวอักษรปุ่ม `อ่าน Memo` ใน popup แผนที่ให้เป็นสีขาวเพื่ออ่านง่ายขึ้น
- เอาปุ่ม `ปรับให้เห็นทุกหมุด` ด้านบนหน้า Map ออก เพราะซ้ำกับปุ่ม `Fit` ใน Map Summary
- คง OpenStreetMap/Leaflet เป็นค่าเริ่มต้น เพราะใช้ฟรีและเหมาะกับช่วงเริ่มต้นของแอพ
- อัปเดต version/cache เป็น `2.7.1` / `travel-memo-v2-7-1`


### v2.7.1 — Map Experience
- อัปเกรดหน้า Map ให้เป็นมุมมองหลักสำหรับย้อนดูความทรงจำบนแผนที่
- เพิ่ม Memo markers จากพิกัด latitude/longitude พร้อม popup เปิด Memo Reading Mode
- เพิ่ม Trip filter, search บนแผนที่, scope filter ของฉัน/Shared/มีรูป
- เพิ่ม Map Summary panel และ Memo list ควบคู่กับแผนที่
- เพิ่ม route line เบื้องต้นเมื่อเลือก Trip และมี Memo มากกว่า 1 จุด
- เชื่อมปุ่มดูแผนที่จาก Trip Detail/Memo Detail เข้ากับ Map Experience
- อัปเดต version/cache เป็น `2.7.1` / `travel-memo-v2-7-1`


### v2.7.1 — Tags + Mood UX
- เพิ่ม Tag Autocomplete ใน Quick Capture / Edit Memo พร้อม suggestions จาก tag ที่เคยใช้
- ปรับ Tag ให้ normalize เป็นรูปแบบเดียวกันและกัน tag ซ้ำ
- เพิ่ม Mood Picker แบบปุ่มแตะง่าย พร้อม mood เพิ่มเติม เช่น ผจญภัย, โรแมนติก, ครอบครัว, ธรรมชาติ และอาหาร
- เพิ่ม Rating Picker แบบ star touch-friendly
- เพิ่ม Tag/Mood Overview ใน Story Timeline เพื่อดู tag/mood ที่ใช้บ่อยและกดกรองได้ทันที
- กด tag หรือ mood จาก Timeline / Memo Reading เพื่อเปิด Timeline พร้อม filter เดียวกัน
- เชื่อม tag/mood เข้ากับ Search + Filter System เดิม
- อัปเดต version/cache เป็น `2.7.1` / `travel-memo-v2-7-1`



### v2.7.1 — Supabase Schema Alignment
- เพิ่ม migration `supabase/migrations/020_photo_schema_alignment.sql` สำหรับจัด schema ตาราง `photos` ให้รองรับ caption, sort order, thumbnail path, EXIF และ metadata แบบปลอดภัยด้วย `add column if not exists`
- เพิ่ม Supabase Schema Alignment panel ใน Admin Dashboard เพื่อแยก schema checklist เป็น required/recommended และบอก column ที่ต้องแก้ชัดเจนขึ้น
- เพิ่มปุ่ม Copy migration SQL และ Copy refresh steps ใน Admin เพื่อคัดลอก SQL/ขั้นตอน refresh schema cache ได้จากหน้าเดียว
- ปรับ Photo schema warning ให้เป็นเครื่องมือเช็ก schema มากกว่า error รบกวนการใช้งาน เมื่อ Dashboard fallback ได้แล้ว
- อัปเดต version/cache เป็น `2.7.1` / `travel-memo-v2-7-1`


### v2.6.7 — Trip Activity Compact Polish
- ปรับกล่อง `ความเคลื่อนไหวล่าสุด` ใน Trip Detail ให้ใช้งานง่ายขึ้นในคอลัมน์ด้านขวา
- ใช้ avatar ผู้ใช้งานแทนการแสดงชื่อเต็มยาว ๆ เพื่อลดการล้นของข้อความ
- แสดงวันที่/เวลาแบบย่อในรายการ และใส่ tooltip เมื่อ hover/focus เพื่อดูผู้สร้างกับเวลาฉบับเต็ม
- เพิ่มรายการล่าสุดเป็น 6 รายการ โดยยังคง layout compact สำหรับ desktop และ mobile
- อัปเดต version/cache เป็น `2.6.7` / `travel-memo-v2-6-7`

### v2.6.7 — Trip Detail Full Render Hotfix
- แก้ error `dedupePhotos is not defined` ที่ทำให้ Trip Detail แบบเต็มเปิดไม่ได้
- เพิ่ม helper `dedupePhotos()` สำหรับรวม/กรองรูปซ้ำก่อนทำ cover และ Photo Highlights
- ปรับ Trip Detail ให้กลับมาแสดงผลแบบเต็มแทน fallback ได้ตามปกติ
- อัปเดต version/cache เป็น `2.6.7` / `travel-memo-v2-6-7`


### v2.6.7 — Trip Detail Action Real Fix

- แก้การกดปุ่ม `ดู Trip` จาก Home และหน้า Trips ให้เปิด Trip Detail ได้จริง
- เพิ่ม trip-action handler แบบ capture ระดับ document เพื่อกัน event หลุดจากปุ่ม/SVG/icon ภายในปุ่ม
- เพิ่ม fallback แบบ emergency สำหรับ Trip Detail ถ้า layout เต็มหรือ fallback เดิม render ผิดพลาด
- ป้องกันกรณี Trip อยู่ใน IndexedDB แต่ยังไม่อยู่ใน state แล้วกดดู Trip ไม่ขึ้น
- อัปเดต version/cache เป็น `2.6.7` / `travel-memo-v2-6-7`

### v2.6.7 — Trip Detail Open Hotfix
- แก้ปุ่ม `ดู Trip` ให้เปิด Trip Detail ได้เสถียรขึ้นจาก Trip card / Home / Timeline hero
- ปรับ `handleTripAction` ให้กัน event ซ้อนและไม่ปล่อยให้ pagination/navigation มากระทบปุ่ม Trip action
- เพิ่ม fallback Trip Detail แบบพื้นฐาน หาก Trip Detail แบบเต็ม render มี error เพื่อไม่ให้ผู้ใช้กดแล้วเงียบ
- เพิ่ม client error log สำหรับ `openTripSheet` เพื่อช่วยตรวจ error ใน Diagnostics
- อัปเดต version/cache เป็น `2.6.7` / `travel-memo-v2-6-7`


### v2.6.7 — Trip Detail Experience

- เพิ่ม Trip Hero / Cover Section ในหน้า Trip Detail โดยใช้รูปเด่นของ Trip หรือ fallback gradient เมื่อยังไม่มีรูป
- เพิ่ม Overview Stats: วันเดินทาง, Memo, รูปภาพ, จุดหมาย, พิกัด และผู้ร่วม Trip
- เพิ่ม Photo Highlights พร้อม Caption และเปิด Gallery Lightbox ได้
- เพิ่ม Map Points Summary พร้อมปุ่มเปิดแผนที่ของ Trip
- ปรับ Better Trip Actions: เพิ่ม Memo, ดู Story Timeline, ดูแผนที่, เชิญเพื่อน, จบ Trip และแก้ไข Trip
- เพิ่ม Shared Trip UX เพื่อบอกเจ้าของ Trip, สิทธิ์ผู้ใช้ และผู้ร่วม Trip ให้ชัดขึ้น
- ปรับ layout Trip Detail ทั้ง desktop และ mobile ให้ดูเป็นหน้าเล่าเรื่องมากขึ้น
- อัปเดต version เป็น `2.6.7` และ cache เป็น `travel-memo-v2-6-7`

### v2.6.2 — Search + Filter System with v2.5.10 Google OAuth

รอบนี้ใช้โค้ด Google OAuth/Auth จาก v2.5.10 เป็นฐานเดิมที่ login ได้ปกติ แล้วนำเฉพาะระบบ Search + Filter ใน Story Timeline กลับเข้ามา โดยไม่แก้ `src/supabase-client.js` หรือ login flow เพิ่มเติม

- เพิ่ม Search bar ใน Story Timeline สำหรับค้นหาจากชื่อ Memo, สถานที่, เมือง, ประเทศ, highlight, story, tags, ชื่อ Trip และ caption รูป
- เพิ่ม filter chips: ทั้งหมด, มีรูป, มีพิกัด, มีเรื่องเล่า, มี Caption, ของฉัน, Shared และ Pending Sync
- เพิ่ม Advanced Filter Panel สำหรับวันที่, ประเทศ, เมือง, mood, rating, sync status และ owner
- เพิ่ม Result Summary แสดงจำนวน Memo, Trip, รูป และจุดหมายที่พบ
- เพิ่ม active filter chips พร้อมปุ่มล้างตัวกรอง
- เพิ่ม empty state สำหรับกรณีค้นหาไม่เจอ
- ค้นหา/filter จาก local state แบบ debounce ไม่ reload หน้า และไม่ทำให้ช่องค้นหาหลุด focus
- เก็บฟังก์ชัน map/location จาก v2.5.10 ไว้ครบ ไม่ลบออกระหว่าง merge
- อัปเดต version เป็น `2.6.2` และ cache เป็น `travel-memo-v2-6-2`

### v2.5.10 — Admin Repair Tools

รอบนี้แก้ User Management search ให้เป็น live filter ในหน้าเดิม ไม่ refresh Dashboard ทั้งหน้าเวลา typing และเพิ่มเครื่องมือซ่อมระบบสำหรับแอดมิน

- แก้ช่องค้นหา User Management ให้ filter รายชื่อผู้ใช้ทันทีโดยไม่ re-render หน้า Admin ทั้งหมด
- เพิ่ม Repair Tools ใน Admin Dashboard
- เพิ่ม Copy Errors สำหรับคัดลอกสรุป sync error
- เพิ่ม Export Diagnostics JSON สำหรับส่งออกข้อมูล debug
- เพิ่ม Repair Shared สำหรับ refresh shared trip cache และซ่อม flag รูปในทริปที่แชร์
- เพิ่ม Requeue Photos สำหรับ mark รูปของผู้ใช้ปัจจุบันให้ sync ใหม่
- เพิ่ม Repair Paths สำหรับเติม storage_path / thumbnail_path ที่ขาดจาก local record เบื้องต้น
- อัปเดต version เป็น `2.5.10` และ cache เป็น `travel-memo-v2-5-10`

### v2.5.9 — Admin User Management

Admin Dashboard รอบนี้เพิ่มเครื่องมือจัดการผู้ใช้ และล้างไฟล์ note/release แยกออกจากโปรเจกต์ เพื่อให้ข้อมูลอัปเดตรวมอยู่ใน README.md หลักบน GitHub

- เพิ่ม User Management ใน Admin Dashboard
- เพิ่มช่องค้นหาผู้ใช้จาก email, display name, user id หรือ role
- เพิ่มตัวกรอง role: all / admin / user
- แสดงจำนวน Trip, Memo และ Photo ของผู้ใช้แต่ละคน
- แสดง activity ล่าสุดของผู้ใช้จาก Trip/Memo/Photo ที่เป็นเจ้าของ
- เพิ่มการเปลี่ยน role ระหว่าง `user` และ `admin` ผ่านหน้า Admin
- ป้องกัน admin เปลี่ยน role ของบัญชีตัวเอง เพื่อลดความเสี่ยงล็อกตัวเองออกจากหน้า Admin
- ปรับ UI ตารางผู้ใช้ให้ compact และใช้งานบนมือถือได้ง่ายขึ้น
- ลบไฟล์ `README_UPDATE_NOTE_*` และ `RELEASE_NOTES_*` ออกจาก zip แล้ว
- อัปเดต version เป็น `2.5.9` และ cache เป็น `travel-memo-v2-5-9`


### v2.6.9 — Memo Reading Mode
- ยกระดับ Memo Detail เป็น Reading Mode สำหรับอ่านเรื่องเล่า ไม่ใช่แค่กล่องรายละเอียด
- เพิ่ม hero photo ของ Memo พร้อม caption และเปิด lightbox ได้
- เพิ่ม Photo Story section ที่แสดงรูปพร้อม caption/metadata แบบเด่นขึ้น
- เพิ่มข้อมูล owner/date/location/trip/tags/mood/rating ใน layout ที่อ่านง่ายขึ้น
- เพิ่มปุ่ม previous/next memo ใน Trip เดียวกัน และ related memo เบื้องต้น
- เพิ่มปุ่มดูแผนที่จาก Memo ที่มีพิกัด
- ปรับ mobile detail sheet ให้อ่านง่ายขึ้นและลดความรกของข้อมูล
- อัปเดต cache เป็น `travel-memo-v2-6-9`


### v2.6.9 — Photo Caption Cleanup
- Removed image dimension/file-size/compression metadata from user-facing photo cards and photo story views.
- Photo cards now show only the image, plus caption only when a caption exists.
- Lightbox no longer falls back to filename/technical metadata as the visible caption.
- Search caption matching now focuses on actual photo captions instead of original file names.


### v2.7.9 — EXIF GPS Hotfix
- ปรับ flow อ่าน EXIF GPS จากไฟล์ต้นฉบับก่อนการ compress ให้ชัดเจนขึ้น
- เพิ่มการเก็บ `exif_latitude`, `exif_longitude`, `location_source` และ `metadata.gps` ใน record รูป
- ปรับ Quick Capture ให้แสดง chip `GPS` หรือ `ไม่มี GPS` พร้อม tooltip สถานะการอ่าน EXIF ของรูปที่เลือก
- ปรับ Repair GPS ให้อ่านพิกัดจากหลาย field: `latitude/longitude`, `exif_latitude/exif_longitude`, `metadata.gps`, `metadata.exif_*`
- ปรับการเติม latitude/longitude ให้เขียนลงช่องและ trigger input event ทันทีเมื่อรูปมี GPS
- ช่วยแยกกรณีรูปไม่มี GPS จริง, ไฟล์ไม่ใช่ JPEG/JPG, HEIC ยังอ่าน GPS ไม่ได้ หรือ EXIF ถูกลบจากแอปอื่น


### v2.7.9 — Map + Location UX Polish
- Added per-photo GPS UX in Quick Capture/Edit Memo so every uploaded photo with EXIF GPS can show its own GPS badge/source.
- Added “ใช้พิกัดนี้กับ Memo” on each GPS-enabled photo so users can choose which photo location becomes the main Memo location.
- Memo location is no longer overwritten automatically when it already has coordinates; users explicitly choose when to replace it.
- Added distance hints when a photo GPS is far from the current Memo location to avoid accidentally assigning the wrong place.
- Added local `location_source` tracking for Memo coordinates such as EXIF GPS, current location, map picker, or manual entry.
- Map popup and Memo Reading now show the location source label where available.
- Location Repair remains safe: it fills only Memo records without coordinates and does not overwrite existing Memo locations.

### v2.7.9 — Map Photo Location Simplify
- Removed duplicated `ดูบนแผนที่` button from Trip Detail sub-sections such as Map Points, keeping map access in the main Trip actions only.
- Removed Photo Location Detail section and per-photo mini map preview from Memo Reading Mode to keep reading mode focused and cleaner.
- Removed Photo markers / Photo route toggles, photo-level map markers, and photo route line from Map Experience.
- Removed reverse geocoding note and photo-location cluster warning from Map Summary.
- Kept per-photo GPS metadata and the `ใช้พิกัดนี้กับ Memo` button in Quick Capture/Edit Memo, but Map now focuses on Memo-level markers and Trip routes.


### v2.7.10 — Photo Lightbox Privacy Hotfix
- จำกัด lightbox/gallery ให้แสดงเฉพาะรูปในบริบทที่เปิด เช่น Memo นั้น, Trip นั้น หรือรูปที่กำลังเลือกใน Quick Capture
- ไม่ใช้รายการรูปทั้งหมดในแอพเป็นแหล่งรูปของ lightbox อีกต่อไป เพื่อลดความเสี่ยงเห็นรูปจาก Trip อื่นหรือผู้ใช้อื่น
- ปรับการเปิดรูปจาก Memo Reading, Trip Detail และ Quick Capture ให้ส่ง context เข้า lightbox ชัดเจนขึ้น
- อัปเดต cache เป็น `travel-memo-v2-7-10`

### v2.8.1 — Sync Status Single Source Polish
- ย้าย/รวมสถานะซิงก์ให้แสดงใต้กล่อง Cloud Profile เพียงจุดเดียว
- ลบ/ซ่อนแถบซิงก์ซ้ำที่เคยแสดงแยกใต้ Cloud Profile
- ปรับ responsive ของสถานะซิงก์ให้ดูเรียบร้อยบนมือถือ
- อัปเดต cache เป็น `travel-memo-v2-8-1`


### v2.8.1 — Google Auth DOM Runtime Fix
- คืน DOM runtime ที่ระบบ sync/auth ใช้อ้างอิงไว้แบบซ่อน เพื่อไม่ให้ JavaScript bootstrap ล้มก่อน Google Login ทำงาน
- เพิ่ม guard ให้ปุ่ม/แถบ sync ที่ถูกซ่อนหรือย้ายตำแหน่งไม่ทำให้หน้า Login พัง
- คง UI สถานะซิงก์แบบแสดงจุดเดียวใต้ Cloud Profile ต่อไป
- อัปเดต cache เป็น `travel-memo-v2-8-1`


## v2.8.1 — Export / Share UX

- เพิ่ม Native Share / Copy share text สำหรับ Memo และ Trip
- เพิ่มปุ่ม Export Memo เป็น HTML และ JSON ใน Memo Reading Mode
- เพิ่มปุ่ม Share / Export ใน Trip Detail
- เพิ่ม Share Preview Card ใน Trip Detail พร้อมสรุปจำนวน Memo, รูป และจุดหมาย
- เพิ่ม Export Trip เป็น HTML อ่านง่าย และ JSON สำหรับสำรอง/นำไปใช้ต่อ
- Export HTML รวมข้อมูลสำคัญ เช่น ชื่อทริป วันที่ จุดหมาย ไฮไลต์ เรื่องเล่า และรูปพร้อม caption
- ยังคงระบบ Google OAuth/Login จากฐานเดิม ไม่แก้ flow auth

### v2.8.1 — Social Share UX Polish
- Removed extra Copy / HTML / JSON export buttons from Memo Reading and Trip Detail primary actions.
- Kept one main Share action and added an in-app social share sheet.
- Added share targets for Facebook, X, LINE, WhatsApp, Email, Instagram helper, Native Share, Copy link, and Copy text.
- Added compact app share URLs using `?m=<memo_id>` and `?t=<trip_id>` with in-app deep-link opening after login.
- Kept export helper code available internally, but simplified the visible UX to reduce clutter.


### v2.8.3 — Public Share Foundation
- Added Trip public/private share controls focused on safe read-only public Trip sharing.
- Added public Trip slug fields and a new Supabase migration: `supabase/migrations/021_public_trip_share_foundation.sql`.
- Added RLS policies for public read-only access to explicitly public Trips, visible Memos inside those Trips, and Photos attached to those visible Memos.
- Added Trip Detail controls for enabling/disabling a Public Link, copying the Public Link, and sharing the public read-only URL.
- Added a read-only public Trip page using `?publicTrip=<slug>` / `?p=<slug>` that shows Trip hero, timeline, photo highlights, and public share footer without edit/delete/admin/sync actions.
- Added basic Open Graph/Twitter metadata updates for public Trip pages inside the SPA, with a note that full crawler metadata may require a server-rendered share route later.
- Public share only exposes Trip content that is explicitly public and visible; private/admin/sync/profile data is not shown on the public page.


### v2.8.5 — Public Trip Story Gallery Polish
- ปรับหน้า Public Trip Story ให้ hero แสดงเฉพาะรูปไฮไลต์ 6 รูป ไม่ใช้รูปใหญ่เด่นจนกินพื้นที่เกินไป
- แก้ตัวเลขลำดับใน Story Timeline ไม่ให้ซ้อนอยู่บนรูปภาพ
- ปรับ chip จำนวนรูปใน Memo public ให้เล็ก กระชับ และไม่กลายเป็นแถบยาว
- เพิ่มการกดรูปใน Public Trip เพื่อเปิดดูรูปใหญ่แบบ lightbox เฉพาะรูปใน public trip นั้น
- จำกัด Photo Highlights ใน public page ให้แสดงชุดไฮไลต์ที่พอดีและอ่านง่ายขึ้น


### v2.8.7 — Public Share Simplify

- Removed Regenerate Public Link and Revoke Public Link controls from Trip Detail and Admin Public Inspector.
- Kept the simpler owner flow: เปิด Public Link / ปิด Public Link / Copy Public Link / Share Public Link.
- Removed the read-only Map Points section from the Public Trip page to keep the public story focused on hero, overview, story timeline, and photo highlights.
- Kept public read-only permissions and existing public slug behavior intact.
