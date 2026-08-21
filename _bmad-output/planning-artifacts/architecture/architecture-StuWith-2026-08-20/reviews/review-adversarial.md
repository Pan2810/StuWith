# Lệ đối kháng — StuWith Architecture Spine

Phương pháp: dựng hai đơn vị một tầng dưới, mỗi đơn vị tuân thủ **đúng từng chữ** mọi AD trong spine, rồi tìm chỗ chúng vẫn build lệch được. Mỗi cặp tìm ra là một lỗ hổng phải bịt bằng AD mới hoặc AD siết lại.

## Verdict

Spine chặt ở đường tiền — AD-3 đến AD-7 bịt gần kín. Nhưng nó **mỏng ở chỗ vòng đời cắt ngang hai chủ ghi**: AD-8 nói ai được ghi cái gì, nhưng không nói chuyện gì xảy ra khi một thực thể của `api` chết trong lúc một thực thể của `realtime-gateway` đang sống dựa vào nó. Bốn trong năm lỗ hổng nằm ở đúng đường nứt đó.

## Findings

### 1. [critical] Đóng phòng trong lúc phiên hỏi riêng đang chạy

**Dựng:** Đội A viết `api`, tuân thủ AD-8: nó sở hữu `rooms`, nên nó viết `DELETE`/`archive` phòng khi host đóng. Đội B viết `realtime-gateway`, tuân thủ AD-8: nó sở hữu `private_sessions` và đang tính coin cho một phiên **bên trong phòng đó**.

Không AD nào nói phòng phải chờ phiên. Kết quả: phòng biến mất, phiên vẫn tick, coin vẫn bị trừ cho một phiên không còn ngữ cảnh — hoặc tệ hơn, khoá ngoại làm tick thất bại im lặng và người dùng học miễn phí. Cả hai đội đều "đúng spine".

**Fix:** AD mới — đóng phòng là một **giao thức hai bước**: `api` đánh dấu phòng `closing` và không nhận người mới; `realtime-gateway` kết thúc mọi phiên đang chạy, chốt sổ block cuối, rồi báo lại; `api` mới đóng hẳn. Không có đường nào xoá cứng một phòng còn phiên sống.

### 2. [high] `room_participants` không có chủ ghi

**Dựng:** Đội A cho rằng `api` ghi `room_participants` khi cấp token (nó biết ai được vào). Đội B cho rằng `realtime-gateway` ghi, vì chỉ nó nhận webhook của LiveKit biết ai **thật sự** đã kết nối. Cả hai đều hợp lý; AD-8 không liệt kê bảng này.

Kết quả: hai bên cùng ghi, đếm số người trong phòng lệch nhau — và **US-1.2 AC3 (chặn join khi phòng đầy) đọc đúng cái số lệch đó**.

**Fix:** bổ sung dòng vào AD-8. Đề xuất: `realtime-gateway` là chủ ghi (sự thật về hiện diện đến từ LiveKit, không từ ý định vào phòng), `api` chỉ đọc khi kiểm trần.

### 3. [high] Host đổi giá giữa phiên đang chạy

**Dựng:** `api` sở hữu hồ sơ, nên nó sở hữu đơn giá (US-2.3 AC1). Đội A cho phép host sửa giá bất cứ lúc nào — không AD nào cấm. `realtime-gateway` đọc giá mỗi lần tick (cách đọc tự nhiên nhất, và cũng không AD nào cấm).

Kết quả: host nâng giá từ 120 lên 500 giữa phiên; Trâm đang học bỗng bị trừ gấp bốn. Thẻ xác nhận cô đã đọc ở `card-ask-confirm` trở thành lời nói dối — và nó **phá thẳng luật "không có gì trừ coin mà không qua thẻ xác nhận"** trong `EXPERIENCE.md`.

**Fix:** AD mới — đơn giá được **chụp ảnh vào `session_participants` lúc người đó vào phiên**. Mọi lần tính tiền đọc giá từ bản chụp, không bao giờ từ hồ sơ hiện tại. Host đổi giá chỉ ảnh hưởng phiên mở sau đó.

### 4. [high] Ban hoặc mất quyền giữa phiên đang chạy

**Dựng:** AD-9 nói token là điểm chốt quyền duy nhất, và token ngắn hạn cấp cho một lần vào phòng. Đội A hiểu đúng: kiểm quyền lúc cấp token. Đội B hiểu đúng: sau khi vào, phiên cứ chạy.

Kết quả: moderator ban một người đang trong phiên hỏi riêng — người đó **vẫn ở trong phòng và vẫn tính tiền** cho tới khi tự thoát, vì không AD nào nói ban phải cắt kết nối đang có. Với sản phẩm mà ẩn danh là giá trị cốt lõi và moderation là đối trọng, đây là lỗ hổng an toàn, không chỉ lỗ hổng tiền.

**Fix:** AD mới — quyền là **thu hồi được**: ban, hạ gói, hoặc chặn theo tuổi phải đẩy được lệnh cắt tới `realtime-gateway`, buộc kết thúc phiên và đuổi khỏi phòng LiveKit qua server SDK. Token ngắn hạn giảm bề mặt, nhưng không thay thế được thu hồi.

### 5. [medium] Không gian khoá idempotent có thể va nhau

**Dựng:** AD-4 định khoá `(session_id, participant_id, block_index)` cho tick. AD-8 nói nạp coin là "lệnh ghi có khoá idempotent" nhưng không nói khoá đó sống ở cột nào. Đội A dùng chung cột `idempotency_key`; đội B dùng cột riêng.

Kết quả: hoặc hai loại giao dịch chen nhau trong một không gian khoá (một `UNIQUE` chặn nhầm giao dịch hợp lệ), hoặc mất tính idempotent cho một trong hai.

**Fix:** sổ cái mang `source` (`session_tick` · `topup` · `system_grant` · `reputation_reward` · `refund`) và `UNIQUE(source, idempotency_key)`. Với `session_tick`, `idempotency_key` được sinh từ bộ ba của AD-4.

### 6. [medium] Luật "không âm" sống ở adapter, không ở domain

**Dựng:** AD-1 cấm `domain` import hạ tầng. AD-6 lại quy định một **hình dạng câu SQL**. Nghĩa là bất biến quan trọng nhất của đường tiền được cưỡng chế ở `packages/db` — nơi AD-1 đẩy nó ra khỏi lõi. Một adapter thứ hai (in-memory cho test, hoặc một DB khác sau này) có thể cài `debit()` mà quên mất điều kiện, và **vẫn tuân thủ mọi AD**.

**Fix:** siết AD-6 — port trong `domain` phải khai kết quả `InsufficientFunds` như một nhánh trả về **bắt buộc xử lý**, không phải exception tuỳ chọn. Mọi adapter phải trả nhánh đó; có bộ test hợp đồng chạy chung cho mọi adapter.

## Không phải lỗ hổng, đã kiểm

- Lệch đồng hồ giữa hai process: chỉ `realtime-gateway` tick, và `started_at` cũng do nó ghi. Kín.
- Ba người trừ song song: AD-6 khoá theo hàng của từng người, không có hàng chung. Kín.
- Client tự báo trạng thái để né tiền: AD-3 đã chặn từ gốc. Kín.
