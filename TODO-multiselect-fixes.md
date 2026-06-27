# Multi-select: 3 vấn đề cần sửa

Tài liệu điều tra cho 3 vấn đề người dùng báo về drag/multi-select trong
`TianAnnotate.vue`. Mỗi mục dưới đây ghi rõ: code hiện tại đang nằm ở đâu,
vì sao nó gây ra vấn đề, và hướng sửa cụ thể. Có tham khảo cách
[agentation](https://github.com/benjitaylor/agentation) (React, content
script) giải quyết các vấn đề tương tự — **chỉ mượn ý tưởng, không copy
code**, vì kiến trúc khác nhau (Vue + `querySelectorAll('*')` toàn trang vs
React + `elementsFromPoint` lấy mẫu điểm + xuyên shadow DOM).

---

## Vấn đề 1 — Multi-select đang chọn trúng con (svg/span) thay vì item logic (div bao ngoài)

### Hiện trạng

`getElementsInRect()` (`src/dom.ts:149-170`) hoạt động như sau:

1. Quét **toàn bộ** `document.querySelectorAll('*')`.
2. Giữ lại element nào có ≥ 60% diện tích nằm trong `dragRect`
   (`MIN_CONTAINMENT_RATIO = 0.6`, `src/dom.ts:147`).
3. Bỏ những element nào **chứa** một element khác cũng match (để không báo
   cả `<nav>` lẫn `<li>` con của nó) — `src/dom.ts:165-167`.

Với DOM ví dụ:

```html
<div class="hero-social-proof">
  <div class="proof-badge"><svg>...</svg><span>100% Free Forever</span></div>
  <div class="proof-badge"><svg>...</svg><span>Privacy First</span></div>
  <div class="proof-badge"><svg>...</svg><span>Works Offline</span></div>
</div>
```

`svg` và `span` bên trong mỗi `.proof-badge` **không chứa nhau** (là 2 anh em
cùng cấp), nên bước 3 không loại được chúng — ngược lại, `.proof-badge` bị
loại vì nó *chứa* `svg`/`span` đã match. Kết quả: 6 item lẻ (3 svg + 3 span)
thay vì 3 `.proof-badge`.

### Vì sao codebase đã có sẵn công cụ để fix

`getMeaningfulTarget(el, options)` (`src/dom.ts:228-258`) đã làm chính xác
việc "đi từ 1 node bất kỳ lên ancestor có ý nghĩa UI" (gộp icon-fragment vào
`<svg>`, leo lên tới element có background/border/shadow hoặc có text riêng,
tối đa `maxDepth` cấp). Hàm này **đang chỉ được dùng cho hover/click đơn**
(`TianAnnotate.vue:254`), **chưa được dùng trong `getElementsInRect`**.

### Hướng sửa

Trong `src/dom.ts`, sửa `getElementsInRect` để **resolve từng candidate qua
`getMeaningfulTarget()` trước khi dedup**, không dedup trên raw leaf nữa:

```ts
export function getElementsInRect(
  rect: { left: number; top: number; width: number; height: number },
  maxResults = 10
): Element[] {
  const resolved = new Set<Element>();

  for (const el of document.querySelectorAll('*')) {
    if (el === document.body || el === document.documentElement) continue;
    if (el.closest('.tian-annotate-ignore')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const overlapX = Math.max(0, Math.min(r.right, rect.left + rect.width) - Math.max(r.left, rect.left));
    const overlapY = Math.max(0, Math.min(r.bottom, rect.top + rect.height) - Math.max(r.top, rect.top));
    const overlapArea = overlapX * overlapY;
    if (overlapArea <= 0) continue;
    if (overlapArea / (r.width * r.height) < MIN_CONTAINMENT_RATIO) continue;

    resolved.add(getMeaningfulTarget(el));
  }

  // Sau khi resolve, vẫn có thể có 1 item chứa 1 item khác (hiếm, ví dụ card
  // lồng card) — giữ lại bước lọc "drop ancestor of another match" làm lưới an toàn.
  const list = Array.from(resolved);
  const leaves = list.filter((el) => !list.some((other) => other !== el && el.contains(other)));

  return leaves.slice(0, maxResults);
}
```

Lưu ý quan trọng:

- `getMeaningfulTarget()` không nhận `options` ở đây → dùng default
  (`precise: false`, `maxDepth: 6`), giống hành vi hover thường. **Không**
  truyền `precise: e.altKey` vào multi-select — Alt trong multi-select chưa
  có ý nghĩa, để mặc định cho đơn giản (có thể mở rộng sau nếu cần).
- Dedup bằng `Set<Element>` để 2 raw leaf (svg + span) cùng resolve về 1
  `.proof-badge` thì chỉ tính 1 lần — đây là phần quan trọng nhất của fix.
- Vẫn giữ ngưỡng `MIN_CONTAINMENT_RATIO` áp dụng trên **raw leaf rect**
  (trước khi resolve), không phải trên rect đã resolve — tránh trường hợp 1
  góc nhỏ của `svg` lọt vào rect kéo theo cả `.proof-badge` lớn hơn nhiều bị
  chọn dù phần lớn nó nằm ngoài vùng kéo. Giữ logic hiện tại y nguyên ở bước
  lọc, chỉ đổi giá trị được `add` vào kết quả.
- Nếu sau khi resolve, 2 candidate khác nhau resolve về **cùng 1 ancestor xa
  hơn cả `.hero-social-proof`** (maxDepth=6 leo quá xa do trang không có CSS
  background/border rõ ràng trên `.proof-badge`) thì đây là vấn đề chung của
  `getMeaningfulTarget` (đã tồn tại từ trước, ảnh hưởng cả hover), không phải
  bug riêng của multi-select — không cần fix trong task này, chỉ cần biết để
  không nhầm lẫn khi test.

### Việc cần làm

- [ ] Sửa `getElementsInRect()` trong `src/dom.ts` theo pseudocode trên.
- [ ] Không cần đổi gì ở `TianAnnotate.vue:266-298` (`onMouseUp`) — vẫn gọi
      `getElementsInRect(...)` như cũ, chỉ kết quả trả về đổi.
- [ ] Test với đúng DOM ví dụ trong issue (3 `.proof-badge` chứa svg+span):
      kéo chọn qua cả 3 → annotation phải có `nearbyElements` ghi `div.proof-badge,
      div.proof-badge, div.proof-badge` (hoặc class cụ thể hơn nếu có), **không**
      có `svg`/`span` riêng lẻ.
- [ ] Test thêm 1 case không bị regression: kéo chọn qua nhiều card/button có
      cấu trúc lồng sâu hơn (ví dụ pricing card có icon + heading + text bên
      trong) — xác nhận vẫn ra đúng 1 item / card, không bị gộp nhầm thành 1
      item to chứa hết.

---

## Vấn đề 2 — Highlight của group được chọn cần là nét đứt (dashed), không phải nét liền (solid)

### Hiện trạng

Có 3 style border liên quan, dễ nhầm với nhau:

| Class | File:line | Border hiện tại | Khi nào hiện |
|---|---|---|---|
| `.tian-annotate-hover-outline` | `TianAnnotate.vue:1010-1015` | `outline: 2px solid #6366f1` | Hover/single-select 1 element |
| `.tian-annotate-drag-overlay` | `TianAnnotate.vue:1254-1260` | `border: 2px dashed #6366f1` | Hình chữ nhật đang kéo (rubber-band), đã là dashed sẵn rồi |
| `.tian-annotate-multiselect-overlay` | `TianAnnotate.vue:1262-1269` | `border: 2px solid #6366f1` | **Khung bao quanh group đã chọn xong**, hiện sau `mouseup` (dùng `getUnionRect()`, bind ở `TianAnnotate.vue:768-769` và computed style `:596-604`) |

Người dùng nói "highlight group được chọn... muốn nét đứt" — đây chính là
`.tian-annotate-multiselect-overlay` (khung union-rect bao quanh các item đã
chọn), **không phải** `.tian-annotate-drag-overlay` (đã dashed từ trước).

### Hướng sửa

Đổi `border: 2px solid #6366f1;` → `border: 2px dashed #6366f1;` tại
`TianAnnotate.vue:1265`. Style tham khảo từ agentation (họ phân biệt rõ:
hover/single-select = solid, multi-select = dashed) — đúng với pattern này:

```css
.tian-annotate-multiselect-overlay {
  position: fixed;
  z-index: 999997;
  border: 2px dashed #6366f1; /* trước: solid */
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.12);
  pointer-events: none;
}
```

- [ ] **Không đổi** `.tian-annotate-hover-outline` (vẫn solid — single
      hover/select không phải group, giữ phân biệt trực quan giữa 2 loại
      selection theo đúng pattern agentation).
- [ ] Nếu làm Vấn đề 3 (live highlight từng item khi đang kéo) thêm 1 class
      mới cho từng item riêng lẻ — class đó cũng nên là dashed (xem mục dưới)
      để đồng bộ "đây là 1 phần của multi-select" về mặt thị giác.
- [ ] Test: kéo chọn 1 vùng, thả chuột, xác nhận khung bao quanh group hiện
      ra là nét đứt màu tím (`#6366f1`), không phải nét liền.

---

## Vấn đề 3 — Highlight item phải live-update theo con trỏ khi đang kéo, không chờ tới `mouseup`

### Hiện trạng

- `onMouseMove` (`TianAnnotate.vue:208-260`), nhánh xử lý kéo multi-select
  (`:224-245`): mỗi lần di chuyển chuột chỉ cập nhật `dragRect.value` (toạ độ
  + kích thước hình chữ nhật đang kéo) để vẽ `.tian-annotate-drag-overlay`.
  **Không có bất kỳ hit-test nào chạy trong lúc kéo.**
- `getElementsInRect()` (tốn — quét toàn bộ `querySelectorAll('*')`) **chỉ
  được gọi 1 lần, tại `onMouseUp`** (`TianAnnotate.vue:270`).
- Kết quả: trong lúc kéo, user chỉ thấy khung rubber-band, không thấy item
  nào sẽ được chọn cho tới khi thả chuột.

### Cách agentation giải quyết (tham khảo ý tưởng)

agentation cập nhật candidate elements **trong `mousemove`**, nhưng **throttle
riêng phần hit-test** (50ms) tách biệt khỏi phần vẽ khung kéo (vẽ khung thì
update mỗi frame, không throttle):

```js
const ELEMENT_UPDATE_THROTTLE = 50;
const now = Date.now();
if (now - lastElementUpdateRef.current < ELEMENT_UPDATE_THROTTLE) return;
lastElementUpdateRef.current = now;
// ... rồi mới recompute candidate elements và update highlight
```

Lý do: hit-test (quét DOM tìm matches) đắt hơn nhiều so với việc chỉ
`translate()` 1 div overlay theo toạ độ chuột — tách throttle ra để khung kéo
vẫn mượt 60fps trong khi hit-test không chạy dồn dập.

### Hướng sửa cho codebase này

**3a. Thêm throttle + state lưu danh sách item đang live-highlight**

Trong `<script setup>` của `TianAnnotate.vue`, gần các ref khác (`dragRect`,
`multiSelectGroupRect`):

```ts
const liveMultiSelectEls = ref<Element[]>([]);
let lastElementHitTestAt = 0;
const ELEMENT_UPDATE_THROTTLE_MS = 50;
```

**3b. Trong `onMouseMove`, nhánh drag-select (`:224-245`)**, sau khi set
`dragRect.value` (sau dòng `242`, trước `return;` ở dòng `243`), thêm:

```ts
const now = performance.now();
if (now - lastElementHitTestAt >= ELEMENT_UPDATE_THROTTLE_MS) {
  lastElementHitTestAt = now;
  const els = getElementsInRect({
    left: Math.min(dragStart.value.x, e.clientX),
    top: Math.min(dragStart.value.y, e.clientY),
    width: Math.abs(dx),
    height: Math.abs(dy),
  });
  // diff với lần trước: bỏ class ở item không còn match, thêm class ở item mới match
  for (const el of liveMultiSelectEls.value) {
    if (!els.includes(el)) el.classList.remove('tian-annotate-multiselect-item-outline');
  }
  for (const el of els) {
    if (!liveMultiSelectEls.value.includes(el)) el.classList.add('tian-annotate-multiselect-item-outline');
  }
  liveMultiSelectEls.value = els;
}
```

(`getElementsInRect` đã nhận `{left, top, width, height}` theo toạ độ
viewport — giống cách `onMouseUp` đang gọi nó ở dòng `268-270`, không cần đổi
signature.)

**3c. Tại `onMouseUp` (`:266-298`)**, có thể tái dùng luôn
`liveMultiSelectEls.value` thay vì gọi lại `getElementsInRect` — tránh tính 2
lần:

```ts
const els = liveMultiSelectEls.value.length
  ? liveMultiSelectEls.value
  : getElementsInRect({ left, top, width: rect.width, height: rect.height }); // fallback nếu throttle chưa kịp chạy lần nào
```

**3d. Dọn dẹp** — phải xoá hết class live-highlight khi kết thúc kéo (cả
trường hợp chọn thành công và trường hợp huỷ/kéo quá nhỏ), nếu không class sẽ
dính lại trên DOM của trang đích:

- Thêm vào cuối nhánh `if (dragRect.value && wasDragging.value ...)` trong
  `onMouseUp` (trước `dragStart.value = null;` ở dòng `295`):
  ```ts
  for (const el of liveMultiSelectEls.value) el.classList.remove('tian-annotate-multiselect-item-outline');
  liveMultiSelectEls.value = [];
  ```
- Tương tự thêm vào nhánh fallback cuối cùng (dòng `340-343`, khi không có
  drag hợp lệ) để dọn cho trường hợp kéo bị huỷ giữa đường.

**3e. CSS — class mới, dashed** (đặt cạnh `.tian-annotate-hover-outline`,
`TianAnnotate.vue:1010-1015`):

```css
.tian-annotate-multiselect-item-outline {
  outline: 2px dashed #6366f1 !important;
  outline-offset: 1px !important;
  pointer-events: none;
}
```

### Cân nhắc performance (quan trọng — đọc trước khi code)

`getElementsInRect()` gọi `document.querySelectorAll('*')` — quét **toàn bộ**
DOM mỗi lần chạy. Với throttle 50ms, trên trang lớn (vài nghìn node) việc này
có thể vẫn giật. Hai lựa chọn, theo độ ưu tiên:

1. **Tối ưu rẻ, giữ nguyên thuật toán** (đề xuất làm trước, đủ cho hầu hết
   trường hợp): tại `onMouseDown` khi bắt đầu 1 lượt kéo multi-select, gọi
   `document.querySelectorAll('*')` **đúng 1 lần**, lưu vào 1 array tạm; mỗi
   tick trong `onMouseMove` chỉ lặp qua array đã cache để tính lại
   `getBoundingClientRect()` + containment, không query lại DOM. Giả định
   hợp lý: trong vài trăm ms kéo chuột, cấu trúc DOM trang không thay đổi.
   → cần thêm tham số overload cho `getElementsInRect` (hoặc 1 hàm
   `getElementsInRectFromCandidates(candidates, rect)`) để tái dùng list đã
   cache.
2. **Đổi hẳn thuật toán sang point-sampling** kiểu agentation
   (`elementsFromPoint` tại ~9 điểm: 4 góc + 4 cạnh giữa + tâm của rect) thay
   cho quét toàn DOM — rẻ hơn nhiều nhưng có thể bỏ sót item nhỏ nằm hoàn
   toàn giữa các điểm sample trên vùng kéo lớn. Chỉ làm nếu mục (1) vẫn không
   đủ mượt sau khi đo thực tế.

→ Bắt đầu với mục (1). Chỉ làm mục (2) nếu profiling cho thấy cần.

### Việc cần làm

- [ ] Thêm `liveMultiSelectEls` ref + throttle timestamp.
- [ ] Cập nhật `onMouseMove` để hit-test + toggle class mỗi
      `ELEMENT_UPDATE_THROTTLE_MS` trong lúc kéo.
- [ ] Cập nhật `onMouseUp` để tái dùng kết quả live, và dọn class ở cả 2
      nhánh kết thúc kéo (thành công + huỷ).
- [ ] Thêm CSS `.tian-annotate-multiselect-item-outline` (dashed).
- [ ] (Tối ưu) Cache `querySelectorAll('*')` 1 lần/lượt kéo theo mục
      "Cân nhắc performance" ở trên.
- [ ] Test: kéo chuột chậm qua vùng có nhiều item — xác nhận từng item sáng
      lên (outline dashed) ngay khi rectangle chạm tới nó, **trước khi**
      thả chuột; thả chuột ra thì outline item chuyển thành khung group
      (Vấn đề 2) và các outline item riêng lẻ biến mất.
- [ ] Test: bắt đầu kéo rồi huỷ (ví dụ kéo rất nhỏ dưới `DRAG_MIN_SIZE`, hoặc
      nhấn Esc nếu có) — xác nhận không còn class outline nào sót lại trên
      trang đích.

---

## Tổng hợp file sẽ động đến

- `src/dom.ts` — sửa `getElementsInRect()` (Vấn đề 1); có thể thêm hàm phụ
  để cache candidates (Vấn đề 3, tối ưu).
- `src/TianAnnotate.vue` —
  - `onMouseMove`/`onMouseUp` (Vấn đề 3).
  - CSS `.tian-annotate-multiselect-overlay` (Vấn đề 2) và CSS mới
    `.tian-annotate-multiselect-item-outline` (Vấn đề 3).

## Thứ tự đề xuất triển khai

1. **Vấn đề 1** trước — độc lập, chỉ sửa `dom.ts`, dễ test riêng (unit test
   được nếu repo có test, hoặc test bằng tay trong demo).
2. **Vấn đề 2** — đổi 1 dòng CSS, không phụ thuộc gì.
3. **Vấn đề 3** cuối — phức tạp nhất, và nên tái dùng `getElementsInRect()`
   đã được fix ở bước 1 (để live-highlight cũng chọn đúng item logic, không
   phải con/lá).

## Tham khảo (agentation — chỉ mượn ý tưởng kiến trúc)

Repo: https://github.com/benjitaylor/agentation — file liên quan:
`package/src/components/page-toolbar-css/index.tsx`,
`package/src/components/page-toolbar-css/styles.module.scss`,
`package/src/utils/element-identification.ts`.

Điểm khác biệt cần lưu ý khi đối chiếu (để không áp dụng sai sang codebase
Vue này):

- Họ dùng React + content-script, hit-test bằng `elementsFromPoint` lấy mẫu
  9 điểm trong vùng kéo (xuyên cả shadow DOM) — **không** ancestor-walk để
  tìm target lúc hit-test; ancestor-walk của họ chỉ dùng để **đặt tên/label**
  element sau khi đã resolve (`identifyElement`).
- Codebase này (`tian-annotate-vue`) đang dùng cách khác — quét toàn bộ
  `querySelectorAll('*')` + containment ratio — và **đã có sẵn**
  `getMeaningfulTarget()` để ancestor-walk tìm "item có ý nghĩa". Vấn đề 1 ở
  trên tận dụng đúng hàm có sẵn này, không cần chuyển sang lối
  `elementsFromPoint` của agentation (trừ khi performance ở Vấn đề 3 buộc
  phải đổi — xem mục "Cân nhắc performance").
- Border dashed-cho-multiselect/solid-cho-hover của agentation khớp với yêu
  cầu ở Vấn đề 2, nên áp dụng trực tiếp.
- Throttle 50ms tách riêng hit-test khỏi vẽ khung kéo của agentation áp dụng
  trực tiếp cho Vấn đề 3.
