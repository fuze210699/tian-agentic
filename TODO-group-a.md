# Nhóm A — client-only feature roadmap

Các tính năng dưới đây làm được hoàn toàn trong `tian-annotate-vue` (không
cần backend/MCP server). Tất cả đều **additive**: props mới có default an
toàn, không phá hành vi hiện tại. Thứ tự đề xuất triển khai theo độ phức tạp
tăng dần.

## 1. Animation pause

**Mục đích**: đóng băng animation/transition đang chạy để annotate đúng vào
1 frame cụ thể (ví dụ annotate vào giữa 1 hiệu ứng loading).

**Việc cần làm**:
- [ ] Thêm prop `pauseAnimations?: boolean` (default `true`) vào `TianAnnotate.vue`.
- [ ] Khi `active === true` và `pauseAnimations`, inject 1 `<style>` tag vào
      `document.head` với rule toàn cục:
      ```css
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition: none !important;
      }
      ```
- [ ] Gỡ style tag đó khi `active === false` (trong `toggleActive()` hoặc
      `watch(active, ...)`).
- [ ] Cân nhắc: loại trừ chính UI của toolbar khỏi rule này (toolbar có thể
      có transition riêng, ví dụ hiệu ứng mở popup) — dùng selector
      `:not(.tian-annotate-ignore *)` hoặc scope class.

**File động đến**: `src/TianAnnotate.vue` (thêm logic, không cần file mới).

**Test**: thêm 1 element có CSS animation vào `demo/App.vue`, bật annotate
mode, xác nhận animation dừng; tắt mode, xác nhận animation chạy lại.

---

## 2. Text-selection annotation

**Mục đích**: chọn 1 đoạn text cụ thể (không phải cả element) để báo lỗi
chính tả/nội dung — field `selectedText` đã có trong `Annotation` type
(`src/types.ts`) nhưng chưa được populate ở đâu cả.

**Việc cần làm**:
- [ ] Trong `TianAnnotate.vue`, thêm listener `selectionchange` (hoặc bắt ở
      `mouseup`) khi `active === true`.
- [ ] Nếu `window.getSelection()` có text không rỗng:
      - Lấy `range.commonAncestorContainer` → element gần nhất chứa selection
        (dùng `closest`/đi lên DOM nếu là text node) làm `pendingPick.el`.
      - Lưu text đã chọn vào `pendingPick.selectedText` (cần thêm field này
        vào object `pendingPick` reactive).
      - Mở popup như flow hiện tại, nhưng hiển thị đoạn text được chọn thay
        vì `describeElement(el)` để user biết đang annotate đúng câu nào.
- [ ] Trong `confirmPick()`, đưa `pendingPick.selectedText` vào
      `addAnnotation({ ..., selectedText })`.
- [ ] Trong `markdown.ts`, thêm dòng `**Selected text:**` khi
      `format !== 'compact'` và `a.selectedText` có giá trị.
- [ ] Quyết định ưu tiên: nếu user vừa có selection vừa click ra ngoài
      (không chọn gì) — flow nào thắng? Đề xuất: nếu có `getSelection()`
      không rỗng tại thời điểm click thì ưu tiên text-selection flow.

**File động đến**: `src/TianAnnotate.vue`, `src/markdown.ts`.

**Test**: chọn 1 đoạn text trong demo, xác nhận popup mở và annotation tạo
ra có `selectedText` đúng nội dung đã chọn.

---

## 3. Multi-select / drag-area selection

**Mục đích**: kéo chọn 1 vùng chứa nhiều element, gộp thành 1 annotation
(`isMultiSelect: true`, `nearbyElements` mô tả các element trong vùng) —
field đã type sẵn trong `Annotation`.

**Việc cần làm**:
- [ ] Thêm state `dragStart: {x,y} | null` và `dragRect: Rect | null`.
- [ ] Trên `mousedown` (khi `active`, không phải trên `.tian-annotate-ignore`):
      bắt đầu ghi `dragStart`. Trên `mousemove` tiếp theo: nếu đã di chuyển
      > ~5px thì coi là đang drag, tính `dragRect` theo vị trí chuột hiện tại
      vs `dragStart`, vẽ 1 overlay hình chữ nhật (CSS `position:fixed`,
      `border: 1px dashed`) để user thấy vùng đang chọn.
- [ ] Trên `mouseup`: nếu có `dragRect` hợp lệ (đủ lớn, ví dụ > 10×10px):
      - Dùng `document.elementsFromPoint` lấy theo lưới điểm trong
        `dragRect` (sample vài điểm, không phải pixel-by-pixel) để gom danh
        sách element nằm trong vùng.
      - Hoặc đơn giản hơn: duyệt toàn bộ `document.querySelectorAll('*')`
        và filter theo `getBoundingClientRect()` giao với `dragRect` (chậm
        hơn nhưng đơn giản hơn — chấp nhận được vì chỉ chạy 1 lần khi thả
        chuột, không phải mỗi frame).
      - Build `nearbyElements` = join danh sách `describeElement()` của các
        element tìm được (giới hạn ví dụ 10 element để tránh markdown quá
        dài).
      - Set `pendingPick.el` = element ngoài cùng (bounding box lớn nhất
        chứa các element con) hoặc `document.body` nếu không xác định được,
        mở popup như flow thường nhưng đánh dấu `isMultiSelect: true`.
      - Nếu không di chuyển đủ xa (chỉ là click thường) → giữ flow click
        đơn hiện tại, không đổi behavior.
- [ ] Trong `confirmPick()`, đưa `isMultiSelect`, `nearbyElements` vào
      `addAnnotation()`.
- [ ] Trong `markdown.ts`, hiển thị `**Nearby elements:**` khi có giá trị.

**File động đến**: `src/TianAnnotate.vue`, `src/dom.ts` (có thể thêm helper
`getElementsInRect(rect): Element[]`), `src/markdown.ts`.

**Rủi ro UX**: drag-select dễ đụng với việc người dùng chỉ muốn click thường
— ngưỡng "đã di chuyển > 5px" là quan trọng để tránh false positive.

**Test**: kéo chọn 1 vùng chứa 2-3 element trong demo, xác nhận annotation
tạo ra có `isMultiSelect: true` và `nearbyElements` chứa đúng tên các
element đó.

---

## 4. Layout mode — "placement"

**Mục đích**: đề xuất thêm 1 component mới vào vị trí cụ thể trên trang
(`kind: "placement"`, field `placement.{componentType,width,height,scrollY,text}`
đã type sẵn).

**Việc cần làm**:
- [ ] Thêm mode switcher trong toolbar panel: `Feedback | Placement | Rearrange`
      (chỉ hiện khi prop `enableLayoutMode` = true, default `false`).
- [ ] Khi ở mode `Placement`: thay vì click vào element có sẵn, user click
      vào **vị trí trống** trên trang → mở popup hỏi:
      - `componentType` (text input tự do, ví dụ "Button", "Card")
      - kích thước đề xuất `width`/`height` (input number, hoặc kéo-thả 1
        khung preview để resize)
      - `text` (nội dung gợi ý, optional)
- [ ] Tại thời điểm tạo annotation, ghi `scrollY: window.scrollY` (vị trí
      cuộn hiện tại, để biết placement nằm ở đâu trong viewport dài).
- [ ] `addAnnotation({ kind: 'placement', placement: {...}, comment, ... })`
      — các field DOM-specific (`elementPath`, `cssClasses`...) có thể bỏ
      qua/để rỗng vì không có element thật để mô tả.
- [ ] Pin hiển thị khác biệt cho `kind: 'placement'` (icon khác, ví dụ dấu
      `+` trong khung vuông nét đứt) để phân biệt với pin feedback thường.
- [ ] `markdown.ts`: thêm nhánh format riêng cho `kind === 'placement'`,
      in ra `componentType`, kích thước, vị trí scroll, text gợi ý.

**File động đến**: `src/TianAnnotate.vue`, `src/markdown.ts`, có thể thêm
`src/dragRect.ts` nếu logic resize-preview phức tạp.

**Test**: chuyển mode Placement, click vào khoảng trống, nhập componentType
"Button" + kích thước, xác nhận annotation có `kind: 'placement'` đúng field.

---

## 5. Layout mode — "rearrange"

**Mục đích**: kéo-di chuyển 1 element đã tồn tại tới vị trí khác (không
submit thật, chỉ ghi nhận đề xuất), so sánh `originalRect` vs `currentRect`.

**Việc cần làm**:
- [ ] Ở mode `Rearrange`: click-giữ vào 1 element có sẵn → bắt đầu drag
      (dùng `mousedown` + `mousemove` + `mouseup`, tương tự multi-select
      nhưng lần này di chuyển 1 clone visual của element, không phải vẽ
      vùng chọn).
- [ ] Ghi `originalRect = getBoundingBox(el)` lúc `mousedown`.
- [ ] Trong lúc drag: render 1 overlay (clone hình ảnh hoặc khung viền) di
      chuyển theo chuột, **không** di chuyển element thật trong DOM (tránh
      phá layout/app state thật).
- [ ] Lúc `mouseup`: `currentRect` = vị trí overlay lúc thả → mở popup nhập
      comment, `addAnnotation({ kind: 'rearrange', rearrange: { selector,
      label, tagName, originalRect, currentRect }, ... })`.
      - `selector` = `getFullPath(el)`, `label` = `describeElement(el)`,
        `tagName` = `el.tagName.toLowerCase()`.
- [ ] Pin/preview hiển thị riêng cho `kind: 'rearrange'` — có thể vẽ 1 mũi
      tên từ `originalRect` tới `currentRect` khi hover vào pin.
- [ ] `markdown.ts`: nhánh format riêng in ra vị trí cũ/mới.

**File động đến**: `src/TianAnnotate.vue`, `src/markdown.ts`.

**Phức tạp nhất trong Nhóm A** — nên làm sau cùng, sau khi multi-select đã
ổn định (tái dùng được phần lớn logic drag-tracking).

---

## 6. Thread / hội thoại trên annotation

**Mục đích**: cho phép thêm message qua lại (human/agent) trên 1 annotation
đã tồn tại — field `thread: ThreadMessage[]` đã có trong type, store thiếu
hàm thêm.

**Việc cần làm**:
- [ ] Thêm hàm `addThreadMessage(id: string, message: Omit<ThreadMessage,
      'id'|'timestamp'>)` vào `useTianAnnotateStore()` (`src/store.ts`) —
      tự sinh `id`/`timestamp`, push vào `annotation.thread`.
- [ ] UI: click vào 1 pin đã có (hiện tại click = xoá luôn, cần đổi behavior)
      → mở popup xem chi tiết annotation đó, gồm:
      - Comment gốc, intent/severity.
      - List `thread` messages nếu có.
      - Input để thêm message mới (role mặc định `'human'`).
      - Nút riêng để xoá (tránh xoá nhầm khi chỉ muốn xem).
- [ ] **Breaking nhỏ về UX** (không breaking về type/API): đổi
      `@click.stop="removeAnnotation(a.id)"` trên pin thành mở popup xem/sửa,
      nút xoá chuyển vào trong popup đó.

**File động đến**: `src/store.ts`, `src/TianAnnotate.vue`.

---

## 7. Trạng thái "acknowledged" / "resolved" qua UI

**Mục đích**: `setStatus()` đã có sẵn trong store nhưng không có UI nào gọi
nó — hiện chỉ có xoá (`removeAnnotation`), không có cách đánh dấu "đã xem"
hay "đã xử lý" mà giữ lại lịch sử.

**Việc cần làm**:
- [ ] Trong popup xem chi tiết annotation (từ mục 6), thêm 2 nút:
      "Mark acknowledged" / "Mark resolved" → gọi `setStatus(id, ...)`.
- [ ] Đổi style pin theo `status`: `pending` (màu tím như hiện tại),
      `acknowledged` (màu khác, ví dụ vàng), `resolved` (xám/mờ, hoặc ẩn
      khỏi view mặc định + có toggle "show resolved").
- [ ] Filter trong panel: thêm dropdown "Show: All / Pending / Resolved".

**File động đến**: `src/TianAnnotate.vue`.

---

## 8. Persist qua reload

**Mục đích**: annotations hiện chỉ sống trong memory, mất khi F5 — không
cần backend, chỉ cần `localStorage`.

**Việc cần làm**:
- [ ] Thêm prop `persistKey?: string` (default: không set = không persist,
      giữ behavior hiện tại để không bất ngờ cho ai đang dùng).
- [ ] Trong `store.ts`, nếu được gọi với key: lúc init đọc
      `localStorage.getItem(key)`, `JSON.parse` vào `annotations`; mỗi lần
      `annotations` thay đổi (dùng `watch(annotations, ..., {deep:true})`
      ở `TianAnnotate.vue`, hoặc 1 `watchEffect` trong `store.ts` nếu muốn
      gom logic vào store), `localStorage.setItem(key, JSON.stringify(...))`.
- [ ] Cân nhắc: store hiện tại là *singleton module-level* (`const
      annotations = reactive([])` ở top-level file) — nếu nhiều instance
      `<TianAnnotate persist-key="a">` và `<TianAnnotate persist-key="b">`
      cùng tồn tại trên 1 trang, chúng đang **share chung 1 store**. Cần
      quyết định: giữ singleton (đơn giản, đúng tinh thần "1 store per
      page" ghi trong comment hiện tại) hay đổi sang factory-per-key. Đề
      xuất: giữ singleton, `persistKey` chỉ là storage key, không tách
      nhiều store — tài liệu hoá rõ trong README.

**File động đến**: `src/store.ts`, `src/TianAnnotate.vue`.

---

## Thứ tự đề xuất

1. Animation pause (độc lập, không đụng store/schema, rủi ro thấp nhất)
2. Persist qua reload (độc lập, đơn giản)
3. Trạng thái acknowledged/resolved qua UI (cần đổi pin-click trước)
4. Thread (đi cùng mục 3 vì cả hai cần popup "xem chi tiết annotation")
5. Text-selection annotation
6. Multi-select / drag-area
7. Layout mode "placement"
8. Layout mode "rearrange" (tái dùng hạ tầng drag từ mục 6)

## Không nằm trong roadmap này

MCP server, API, webhooks, realtime sync (SSE), session lifecycle — xem lại
phần "Nhóm B" đã thảo luận, đây là một dự án backend riêng, không thuộc
phạm vi package UI này.
