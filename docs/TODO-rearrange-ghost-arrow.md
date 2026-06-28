# Rearrange mode — Shadow ghost thật + mũi tên chỉ đường (giống Agentation)

Phạm vi: `src/TianAnnotate.vue` (script + template + style). Không cần đổi `src/store.ts`,
`src/sync.ts`, `src/types.ts` — annotation `kind: 'rearrange'` đã lưu đủ `originalRect` +
`currentRect`, đây chỉ là cải thiện UX lúc đang kéo, không đổi data model.

## Bối cảnh

Bên agentation.com, khi kéo 1 element ở rearrange mode: (1) một **bản shadow/ghost thật** của
element đó bám theo con trỏ trong lúc kéo, và (2) sau khi thả, có **mũi tên** nối từ vị trí gốc
đến vị trí mới. Hiện tại tian-agentic chưa có cả hai:

- Lúc kéo: chỉ hiện 1 badge nhỏ ghi tên element (`describeElement(el)`) trong khung viền nét đứt
  — không phải hình ảnh thật của element (`TianAnnotate.vue:1616-1626`, CSS `:2500-2512`).
- Sau khi thả: popup chỉ hiện text thuần `From x,y → x,y` (`TianAnnotate.vue:1762-1769`) — không
  có đường/mũi tên vẽ trên màn hình.

## Việc cần làm — Phần 1: Shadow ghost thật của element

### Hiện trạng cần biết trước khi sửa

- State hiện tại: `rearrangeClone = ref<{ el: Element; x: number; y: number } | null>(null)`
  (`:276`).
- Gán lúc bắt đầu kéo: `onMouseDown`, nhánh `mode.value === 'rearrange'` (`:510-520`).
- Update lúc đang kéo: `onMouseMove`, nhánh `dragStart.value && dragEl.value && mode.value ===
  'rearrange'` (`:543-551`).
- Dọn dẹp lúc thả tay: `onMouseUp`, nhánh `rearrangeClone.value && wasDragging.value &&
  dragEl.value` (`:688-726`) — set `rearrangeClone.value = null` ở cuối (`:724`).
- Render hiện tại: `TianAnnotate.vue:1616-1626` (div badge text) + CSS `.tian-annotate-rearrange-
  clone` (`:2500-2512`).
- Pattern tham khảo cho "giữ 1 DOM node ngoài reactivity của Vue" đã có sẵn trong file:
  `let blockOverlay: HTMLDivElement | null = null;` (`:146`), dùng trong `injectBlockInteraction`
  — copy đúng pattern này cho ghost node (không bọc DOM Element vào `ref`/`reactive`, Vue proxy
  DOM node thật dễ gây lỗi/perf kém).

### Cách làm

1. Thêm biến module-level (đặt gần `blockOverlay`, khoảng dòng 146):
   ```ts
   let rearrangeGhostNode: HTMLElement | null = null;
   ```

2. Trong `onMouseDown`, nhánh rearrange (`:510-520`), **sau khi** đã có `el` hợp lệ — chưa tạo
   ghost ngay ở mousedown (chỉ tạo khi thực sự vượt `DRAG_THRESHOLD`, xem bước 3, để tránh tạo
   ghost cho 1 click không kéo).

3. Trong `onMouseMove`, nhánh rearrange đang kéo (`:543-551`), ngay khi `wasDragging.value` vừa
   chuyển sang `true` lần đầu (tức là đoạn `if (Math.abs(dx) > DRAG_THRESHOLD || ...)` mới chạy
   lần đầu cho lượt kéo này — kiểm tra bằng `!rearrangeGhostNode`):
   - Lấy kích thước thật: `const rect = dragEl.value.getBoundingClientRect();`
   - Danh sách thẻ không nên `cloneNode` trực tiếp (xem mục Rủi ro): `VIDEO`, `AUDIO`, `CANVAS`,
     `IFRAME`, `OBJECT`, `EMBED`. Nếu `dragEl.value.tagName` thuộc danh sách này, tạo 1 `div`
     placeholder cùng kích thước, có text label tên element ở giữa, thay cho clone thật.
   - Ngược lại, `cloneNode(true)`:
     ```ts
     const clone = dragEl.value.cloneNode(true) as HTMLElement;
     clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
     clone.removeAttribute('id');
     ```
     (xoá hết `id` trong cây con để không bị trùng id với DOM gốc đang sống — tránh side-effect
     `querySelector`/CSS `:target`/label `for=...`).
   - Set style cho ghost (dùng `Object.assign(clone.style, {...})` hoặc set từng dòng):
     - `position: fixed`
     - `width: rect.width + 'px'`, `height: rect.height + 'px'` (giữ đúng kích thước gốc)
     - `left/top`: set ban đầu = vị trí chuột hiện tại (xem bước style, ghost bám tâm vào chuột
       qua `transform: translate(-50%, -50%)`, không cần tính lệch tay so với vị trí gốc — UX
       đơn giản hơn agentation 1 chút nhưng đủ rõ ràng)
     - `margin: 0` (clone có thể kế thừa margin từ context cũ, fixed positioning + margin gây
       lệch — set `margin: 0` để width/height chính xác)
     - `pointer-events: none`
     - `z-index: 999997` (xem bảng z-index ở cuối doc)
     - class thêm: `tian-annotate-rearrange-ghost tian-annotate-ignore` (class `tian-annotate-
       ignore` **bắt buộc** — đây là class các hàm `isIgnored()` dùng để loại trừ UI của chính
       tian-annotate khỏi hit-test; nếu thiếu, ghost sẽ tự bị coi là "target" khi hover/click đè
       lên nó)
   - `document.body.appendChild(clone)`; lưu vào `rearrangeGhostNode = clone`.
   - Vẫn giữ nguyên `rearrangeClone.value = { el: dragEl.value, x: e.clientX, y: e.clientY }` như
     hiện tại — dùng cho cả arrow ở Phần 2 và cho badge tên nhỏ (xem CSS bên dưới, badge giữ lại
     làm fallback).

4. Mỗi lần `onMouseMove` tiếp theo trong lúc đang kéo (vẫn nhánh `:543-551`): nếu
   `rearrangeGhostNode` đã tồn tại, update vị trí:
   ```ts
   rearrangeGhostNode.style.left = e.clientX + 'px';
   rearrangeGhostNode.style.top = e.clientY + 'px';
   ```

5. Dọn dẹp ghost — phải remove ở **tất cả** các điểm thoát khỏi trạng thái kéo, không chỉ
   `onMouseUp` happy-path:
   - `onMouseUp`, cuối nhánh xử lý rearrange (`:724`, ngay trước `rearrangeClone.value = null;`):
     thêm `rearrangeGhostNode?.remove(); rearrangeGhostNode = null;`
   - `onMouseUp`, nhánh fallback dọn dẹp chung ở cuối hàm (`:728-735`, nơi đã có
     `rearrangeClone.value = null;`) — thêm cùng 2 dòng remove ở đây để cover trường hợp kéo bị
     huỷ giữa đường (vd `wasDragging` chưa kịp true).
   - `cancelPick()` (`:829-834`): thêm remove ghost — đề phòng user kéo xong, popup đã mở, rồi
     nhấn Esc trước khi confirm.
   - `toggleActive()` khi tắt annotate mode (`:818-827`): thêm remove ghost.

### CSS

Đổi/thêm cạnh `.tian-annotate-rearrange-clone` hiện tại (`:2500-2512`) — **giữ nguyên** class cũ
làm badge tên nhỏ (đặt góc trên-trái của ghost để vẫn biết tên element kể cả khi ghost render
không rõ, ví dụ element nền trong suốt), thêm class mới cho ghost:

```css
.tian-annotate-rearrange-ghost {
  position: fixed;
  z-index: 999997;
  pointer-events: none;
  opacity: 0.65;
  outline: 2px dashed #8b5cf6;
  outline-offset: 2px;
  border-radius: 4px;
  transform: translate(-50%, -50%);
  transition: none; /* bám chuột tức thì, không lag theo easing */
  overflow: hidden;
}
```

Badge `.tian-annotate-rearrange-clone` cũ: đổi `position: fixed` lúc này nên đặt **relative theo
ghost** nếu dễ implement (badge là con của ghost trong DOM), hoặc đơn giản hơn — giữ độc lập như
hiện tại nhưng dịch nhẹ lên trên ghost bằng cách set `top`/`left` trừ thêm chiều cao ghost/2. Nếu
việc tính toán lệch vị trí giữa 2 overlay độc lập quá rối, cách đơn giản nhất: append badge **là
con DOM của `rearrangeGhostNode`** (tạo bằng `document.createElement('span')`, set text =
`describeElement(el)`, style absolute top/left góc trên-trái của ghost) — tránh phải đồng bộ 2
state riêng biệt.

## Việc cần làm — Phần 2: Mũi tên từ vị trí cũ → vị trí mới

### Hiện trạng cần biết trước khi sửa

- `pendingPick.rearrangeOriginalRect` / `rearrangeCurrentRect`: kiểu `Rect | null`, set lúc thả
  tay tại `onMouseUp` (`:719-720`), dùng **document coordinates** (đã cộng `scrollX/scrollY`, trừ
  khi `isFixedOrSticky(el)` — xem comment tại `:692-696`).
- Popup hiện hiển thị text thuần tại `:1762-1769`.
- `scrollPos` (`ref<{x,y}>`) đã có sẵn, update qua `onScroll` (`:533-535`) — dùng để quy đổi
  document coordinates → viewport coordinates khi vẽ SVG `position: fixed`.

### Cách làm

1. Thêm 1 `computed` mới (đặt cạnh các computed khác trong `<script setup>`), trả về toạ độ
   **viewport** (vì SVG overlay sẽ là `position: fixed`) của điểm đầu/cuối mũi tên, hoặc `null`
   nếu không có gì để vẽ:

   ```ts
   const rearrangeArrow = computed(() => {
     // Đang kéo (chưa thả tay): vẽ từ tâm element gốc tới vị trí chuột hiện tại.
     if (dragEl.value && wasDragging.value && mode.value === 'rearrange') {
       const rect = dragEl.value.getBoundingClientRect();
       return {
         x1: rect.left + rect.width / 2,
         y1: rect.top + rect.height / 2,
         x2: mouseX.value,
         y2: mouseY.value,
       };
     }
     // Đã thả tay, popup confirm đang mở: vẽ cố định original -> current.
     if (
       pendingPick.rearrangeOriginalRect &&
       pendingPick.rearrangeCurrentRect &&
       mode.value === 'rearrange'
     ) {
       const o = pendingPick.rearrangeOriginalRect;
       const c = pendingPick.rearrangeCurrentRect;
       return {
         x1: o.x + o.width / 2 - scrollPos.value.x,
         y1: o.y + o.height / 2 - scrollPos.value.y,
         x2: c.x + c.width / 2 - scrollPos.value.x,
         y2: c.y + c.height / 2 - scrollPos.value.y,
       };
     }
     return null;
   });
   ```

   Lưu ý: nhánh 2 trừ `scrollPos` để quy đổi document coords → viewport coords — **chỉ áp dụng
   khi `!pendingPick.rearrangeIsFixed`**; nếu element là fixed/sticky thì rect đã ở viewport
   coords ngay từ đầu (xem comment gốc tại `:692-696` để hiểu rõ 2 hệ toạ độ này). Worker cần xử
   lý đúng case `rearrangeIsFixed` ở đây giống cách `confirmPick` đang xử lý (`:880-883`).

2. Thêm SVG overlay trong template, đặt cạnh phần `<!-- rearrange clone overlay -->` hiện tại
   (`:1616-1626`):

   ```html
   <svg
     v-if="rearrangeArrow"
     class="tian-annotate-rearrange-arrow tian-annotate-ignore"
   >
     <defs>
       <marker
         id="tian-annotate-arrow-head"
         markerWidth="8"
         markerHeight="8"
         refX="6"
         refY="4"
         orient="auto"
       >
         <path d="M0,0 L8,4 L0,8 Z" fill="#8b5cf6" />
       </marker>
     </defs>
     <line
       :x1="rearrangeArrow.x1"
       :y1="rearrangeArrow.y1"
       :x2="rearrangeArrow.x2"
       :y2="rearrangeArrow.y2"
       stroke="#8b5cf6"
       stroke-width="2"
       stroke-dasharray="6 4"
       marker-end="url(#tian-annotate-arrow-head)"
     />
     <circle :cx="rearrangeArrow.x1" :cy="rearrangeArrow.y1" r="4" fill="#8b5cf6" />
   </svg>
   ```

3. CSS:

   ```css
   .tian-annotate-rearrange-arrow {
     position: fixed;
     inset: 0;
     width: 100vw;
     height: 100vh;
     z-index: 999995; /* dưới ghost (999997) để ghost luôn nổi rõ hơn đường line */
     pointer-events: none;
     overflow: visible;
   }
   ```

4. Marker `id="tian-annotate-arrow-head"` là global trong DOM — nếu page nhúng nhiều hơn 1
   instance `TianAnnotate` cùng lúc sẽ bị trùng id. Các phần khác của component (vd. CSS variable
   `--tian-accent`) cũng đang giả định single-instance, nên **không cần xử lý multi-instance** ở
   v1 này — chỉ ghi chú lại để không ai ngạc nhiên nếu sau này có yêu cầu đó.

### Khi nào ẩn arrow

`rearrangeArrow` đã là computed dựa trên state hiện có (`dragEl`, `wasDragging`,
`pendingPick.rearrangeOriginalRect/CurrentRect`, `mode`) — **không cần thêm state riêng để
ẩn/hiện**, chỉ cần đảm bảo các hàm dọn dẹp đã xoá đúng state nguồn:

- `cancelPick()` (`:829-834`): đã set `pendingPick.el = null` — cần xác nhận
  `pendingPick.rearrangeOriginalRect`/`rearrangeCurrentRect` cũng được reset ở đây (hiện tại
  `cancelPick` **không** reset 2 field này — cần thêm `pendingPick.rearrangeOriginalRect = null;
  pendingPick.rearrangeCurrentRect = null;` vào `cancelPick`, nếu không arrow sẽ tiếp tục hiển
  thị "ma" sau khi huỷ popup).
- `confirmPick()`, nhánh rearrange thành công (`:870-...`, ngay sau `addAnnotation(...)`): xác
  nhận có reset `pendingPick.rearrangeOriginalRect/CurrentRect` về `null` — nếu code hiện tại
  chưa làm (đọc kỹ đoạn sau `addAnnotation` trong nhánh này), thêm vào.

## Việc cần làm — Phần 3: Dọn dẹp chung

- Rà lại `onBeforeUnmount` (`:1150` khu vực, hàm cleanup khi component bị unmount) — thêm
  `rearrangeGhostNode?.remove();` để không rò rỉ DOM node nếu component bị gỡ giữa lúc đang kéo
  (hiếm nhưng nên có).

## Việc cần làm — Phần 4: Test (`tests/e2e/run.mjs`)

Thêm vào block "Phase 9 — layout mode" (file test hiện có, tìm đoạn liên quan `'l'` key /
wireframe để chèn nối tiếp):

1. Bật rearrange mode: `page.keyboard.press('l')` 2 lần từ feedback (feedback → placement →
   rearrange), hoặc set qua `<select>` mode trong Settings panel.
2. Giả lập kéo 1 element trên trang demo (ví dụ `.card__title` hoặc `.submit-btn`):
   - `page.mouse.move(x1, y1)`, `page.mouse.down()`, `page.mouse.move(x2, y2, { steps: 10 })`
     (di chuyển đủ xa để vượt `DRAG_THRESHOLD = 5`, xem `:293`).
   - Assert `.tian-annotate-rearrange-ghost` xuất hiện đúng 1 lần trong DOM.
   - Assert `.tian-annotate-rearrange-arrow line` tồn tại, và `x2`/`y2` của nó gần khớp với
     `(x2, y2)` vừa di chuột tới (cho phép sai số nhỏ).
3. `page.mouse.up()`:
   - Assert ghost đã bị remove khỏi DOM (`count() === 0`).
   - Assert popup confirm (`.tian-annotate-popup`) đang mở, và arrow vẫn còn (`count() === 1`)
     nhưng giờ nối từ vị trí gốc cố định tới vị trí thả — không còn đổi theo chuột.
4. Điền comment, bấm "Add" để confirm — assert arrow biến mất sau khi annotation được tạo.
5. Lặp lại nhưng nhấn Esc thay vì confirm ở bước 4 — assert arrow + ghost đều biến mất (test case
   cancel, nơi dễ bị bỏ sót dọn dẹp nhất).

## Rủi ro / lưu ý cho worker

- **`cloneNode` với media/canvas/iframe**: `<video>`/`<audio>` clone có thể tự phát lại từ đầu
  hoặc phát ra tiếng động trùng với bản gốc; `<canvas>` clone giữ ảnh tĩnh tại thời điểm clone
  nhưng không tiếp tục vẽ theo bản gốc (dễ gây hiểu lầm "ghost bị đứng hình"); `<iframe>` clone có
  thể load lại nội dung (tốn tài nguyên, có thể gây lỗi CORS/console). → bắt buộc dùng placeholder
  div thay clone thật cho các tag này (đã ghi ở Phần 1, bước 3).
- **Trùng `id`**: phải xoá hết `id` trong cây con clone (Phần 1, bước 3) — nếu bỏ qua bước này,
  bất kỳ code nào trên trang dùng `document.getElementById` hoặc CSS `#id` có thể bị ảnh hưởng vì
  giờ có 2 phần tử cùng id trên DOM.
- **Animation pause toàn cục**: component có cơ chế "pause animations on page" hiện có (tìm
  `animationsPaused` trong file) áp dụng style injection lên các phần tử của *trang*, loại trừ
  qua class `tian-annotate-ignore`. Ghost clone kế thừa class/style gốc của element bị clone, nên
  nếu element gốc có animation và đang bị pause, ghost cũng tự động bị pause theo (không cần xử
  lý thêm) — chỉ cần đảm bảo class `tian-annotate-ignore` được thêm vào ghost wrapper để chính
  ghost không bị các hành vi khác của tian-annotate (vd. hover outline, hit-test) nhận lầm là một
  phần tử của trang.
- **Bảng z-index hiện có trong file** (để xếp lớp đúng, không che lẫn nhau):
  - `.tian-annotate-wireframe-overlay`: `999990`
  - `.tian-annotate-wireframe-grid`: `999991`
  - `.tian-annotate-wireframe-ruler-top/-left`: `999992`
  - `.tian-annotate-rearrange-arrow` (mới): `999995` (đề xuất)
  - `.tian-annotate-rearrange-clone` (badge cũ): `999997`
  - `.tian-annotate-rearrange-ghost` (mới): `999997` (cùng lớp với badge — badge là con DOM của
    ghost theo đề xuất ở Phần 1 nên không cần z-index riêng)
  - Toolbar / block-interaction overlay: `9999999` (luôn trên cùng, không đổi)

## Thứ tự triển khai đề xuất

1. Phần 1 (ghost clone) — risk thấp hơn, độc lập với popup logic, dễ test bằng mắt trước.
2. Phần 2 (arrow SVG) — tái dùng rect data đã có sẵn từ Phần 1 không đổi gì thêm.
3. Phần 3 (dọn dẹp cancel/unmount) — dễ bị quên, làm ngay sau khi 2 phần trên chạy được để không
   để sót state "ma" (ghost/arrow còn sót lại sau khi huỷ).
4. Phần 4 (test) — viết sau khi đã tự test thủ công bằng tay trên demo (`npm run dev`, mở
   `enable-layout-mode`, thử kéo nhiều loại element: text, button, và 1 `<iframe>`/`<video>` nếu
   demo có, để xác nhận placeholder fallback hoạt động đúng trước khi viết assertion).
