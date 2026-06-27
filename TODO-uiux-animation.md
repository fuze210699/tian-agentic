# Kế hoạch cải thiện UI/UX & Animation cho tian-agentic

Phạm vi: `src/TianAnnotate.vue` (component chính), liên quan `src/store.ts`, `src/sync.ts`.

## 1. Tooltip hover (`.tian-annotate-tag`)

**Hiện trạng** (`TianAnnotate.vue:957-965`, CSS `:1420`): hiển thị bằng `v-if`, xuất hiện/biến mất tức thì khi hover, không có transition.

**Việc cần làm:**
- Bọc bằng `<Transition name="tian-tag">` (hoặc đổi `v-if` → `v-show` + CSS transition trên `opacity`/`transform`) để fade + scale nhẹ khi mount/unmount.
- Thêm CSS:
  ```css
  .tian-tag-enter-active, .tian-tag-leave-active { transition: opacity 100ms ease-out, transform 100ms ease-out; }
  .tian-tag-enter-from, .tian-tag-leave-to { opacity: 0; transform: translateY(2px) scale(0.97); }
  ```
- Vì tag bám theo `mouseX/mouseY` (di chuyển liên tục), animation chỉ nên áp dụng cho enter/leave, không animate vị trí khi di chuột (tránh lag theo chuột).

## 2. Settings panel (`.tian-annotate-panel`)

**Hiện trạng** (`:841`, toggle bằng `showSettings` ở `:204`, CSS `:1358`): `v-if` bật/tắt tức thì, không animation.

**Việc cần làm:**
- Bọc bằng `<Transition name="tian-panel">`.
- Animation dạng slide-down + fade (panel nằm dưới toolbar):
  ```css
  .tian-panel-enter-active, .tian-panel-leave-active { transition: opacity 120ms ease-out, transform 120ms ease-out; transform-origin: top; }
  .tian-panel-enter-from, .tian-panel-leave-to { opacity: 0; transform: translateY(-4px) scaleY(0.96); }
  ```
- Đồng bộ thời gian (~120-150ms) với nút toggle settings (icon đổi trạng thái `is-on` ở `:936`) để cảm giác mượt, không giật.

## 3. Nút "Fix with Claude" / "Fix with OpenCode" — loading state

**Hiện trạng** (`:1180-1191`, logic `runAgent` ở `:730-737`, state `dispatching` ở `:125`): khi click, disable cả 2 nút + đổi text thành "Starting…", không có spinner, không có animation nào khác trong lúc agent đang chạy.

**Việc cần làm:**
- Thêm spinner icon inline trong nút khi `dispatching === 'claude' | 'opencode'` (SVG xoay hoặc CSS `@keyframes spin`).
- Thêm class `.is-loading` lên nút đang active để style riêng (vd. shimmer/pulse nhẹ trên background) khác với nút bị disable do nút kia đang chạy.
- Xác nhận lại vòng đời `dispatching`: hiện tại set `dispatching.value = agent` rồi gọi API, nhưng cần kiểm tra `runAgent` (`:730-737`) có set `dispatching.value = null` đúng lúc response trả về (thành công/lỗi) — nếu agent thực thi lâu (gọi Claude/OpenCode xử lý code thật), nên hiển thị trạng thái "đang chạy" lâu hơn (không chỉ "Starting…" lúc gọi API mà cả khi agent đang process), có thể cần thêm field "agentStatus" từ backend (qua `sync.ts` polling/SSE) để biết agent đã xong hay chưa, thay vì chỉ biết request dispatch đã gửi.
- Disable cả textarea/Edit-comment trong lúc dispatching để tránh sửa annotation khi agent đang chạy trên annotation đó.

## 4. Modal edit comment — khóa Edit khi đã resolved

**Hiện trạng** (`:1139-1151`): nút "Edit" và textarea hiển thị/cho sửa bất kể `selectedAnnotation.status`. Type `Annotation.status` (trong `types.ts`) có giá trị `'resolved'` nhưng UI hiện không kiểm tra — đây là bug theo yêu cầu.

**Việc cần làm:**
- Thêm điều kiện disable nút Edit khi `selectedAnnotation.status === 'resolved'`:
  ```vue
  <button v-if="!editingComment" type="button" class="tian-annotate-link-btn"
    :disabled="selectedAnnotation.status === 'resolved'"
    @click="startEditComment">Edit</button>
  ```
- Style nút disabled (opacity giảm, cursor `not-allowed`), có thể thêm tooltip/label nhỏ "Resolved comments can't be edited".
- Đảm bảo `startEditComment()` (`:710`) cũng guard lại điều kiện này ở code (không chỉ ẩn UI) để tránh gọi nhầm từ nơi khác.
- Cân nhắc: nếu annotation resolved bởi agent (`resolvedBy: 'agent'`), có thể hiện badge nhỏ bên cạnh "Comment" label báo trạng thái resolved.

## 5. Modal/popup khác (đồng bộ animation chung)

Các overlay sau hiện đều `v-if` tức thì, không animation — nên đồng bộ cùng 1 pattern Transition để toàn bộ UI nhất quán:
- `.tian-annotate-detail-overlay` (modal chi tiết comment, `:1120`)
- `.tian-annotate-popup` (feedback / placement / rearrange popup, `:996`, `:1031`, `:1082`)

**Việc cần làm:**
- Tạo 1 bộ class animation chung (vd. `tian-fade-scale`) dùng cho tất cả overlay/popup/modal:
  ```css
  .tian-fade-scale-enter-active, .tian-fade-scale-leave-active { transition: opacity 130ms ease-out, transform 130ms ease-out; }
  .tian-fade-scale-enter-from, .tian-fade-scale-leave-to { opacity: 0; transform: scale(0.96); }
  ```
- Áp cho overlay (backdrop) một `transition: opacity` riêng nếu có backdrop riêng, để feel layered đúng cách (backdrop fade nhanh hơn nội dung modal đôi chút).
- Tôn trọng cơ chế "animation pause" hiện có (`:151-163`, `animationsPaused`) — animation mới của tooltip/panel/modal phải bị tắt khi `animationsPaused = true`, tránh xung đột với mục đích demo "pause animations on page" hiện tại (đảm bảo style injection chỉ target phần tử của page, không phải UI điều khiển của tian-agentic chính nó — `tian-annotate-ignore` đã có sẵn để loại trừ, cần verify animation mới cũng được gắn class này).

## 6. Thứ tự triển khai đề xuất

1. Thêm 2 class Transition dùng chung (`tian-fade-scale`, `tian-tag`, `tian-panel`) — low risk, không đổi logic.
2. Áp dụng cho tooltip hover + settings panel.
3. Áp dụng cho detail overlay + 3 popup (feedback/placement/rearrange).
4. Fix bug Edit-when-resolved (logic, không liên quan animation — có thể làm độc lập, ưu tiên cao vì là bug đúng/sai chứ không phải polish).
5. Thêm spinner/loading visual cho 2 nút Fix with Claude/OpenCode + disable phụ (textarea, edit) trong lúc dispatching.
6. Test thủ công: hover tooltip, mở/đóng settings, mở từng loại popup, click Fix with Claude/OpenCode (giả lập network chậm), thử edit comment đã resolved.

## 7. Không thuộc phạm vi animation (ghi nhận riêng, không trộn vào đây)

`TODO-multiselect-fixes.md` đã có sẵn 3 issue riêng về multi-select (chọn nhầm phần tử con, viền nét đứt, live-update khi kéo) — không gộp vào đây, xử lý theo file đó.
