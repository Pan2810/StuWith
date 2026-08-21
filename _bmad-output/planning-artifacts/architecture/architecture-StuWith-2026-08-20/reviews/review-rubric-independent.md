# Rubric walker độc lập — StuWith Architecture Spine

> Lệ này chạy **độc lập**, trong ngữ cảnh sạch, đối chiếu `ARCHITECTURE-SPINE.md` với good-spine checklist ở `references/reviewer-gate.md`, với định nghĩa "spine là gì" ở `bmad-architecture/SKILL.md § Overview`, và với ba nguồn chịu lực: `docs/prd.md` (19 US), `EXPERIENCE.md`, `DESIGN.md`.
>
> **Phạm vi đã đọc để không lặp lại:** ba lệ đã chạy trước (`review-adversarial.md`, `review-rubric.md`, `review-versions.md`) và bản spine **đã cập nhật lên AD-23** (đọc lại lúc 21:2x ngày 20/08 — spine đã đổi giữa lúc lệ này đang chạy). Mọi finding dưới đây là thứ chưa lệ nào nêu, **hoặc** là hệ quả mới sinh ra từ chính vòng vá vừa rồi.
>
> **Đã kiểm và xác nhận đã vá, không tính lại:** CI/CD (→ AD-20) · chiến lược test · quan trắc · định nghĩa "phá vỡ tương thích" của `/v1` · neo block theo `joined_at` (→ AD-4 mới) · cửa sổ ân hạn 30 giây (→ AD-23) · đường thi hành ban không qua psql (→ AD-18 Rule mới) · trần phòng kiểu check-then-act (→ AD-22) · Caddy vs Traefik · pin phiên bản Stack · chủ ghi của điểm uy tín (→ AD-8 Rule "bảng phủ hết").

---

## Kết luận tổng thể

**Chưa đạt để bàn giao — nhưng lý do đã đổi hẳn tính chất so với vòng trước.**

Vòng vá vừa rồi rất hiệu quả: AD-21 (phiên là phòng LiveKit riêng), AD-22 (kiểm trần phải kèm giữ chỗ), AD-23 (máy trạng thái có `suspended`), cộng các Rule mới của AD-3/AD-4/AD-5/AD-8/AD-9/AD-18 đã đóng gần hết lớp lỗ hổng "hai đơn vị build lệch ở đường tiền". Đường tiền của spine này bây giờ là công việc trên mức trung bình rõ rệt.

Nhưng vòng vá đó được thực hiện bằng cách **thêm AD chồng lên AD mà không chạy lại phép kiểm nhất quán giữa chúng**, và kết quả là spine hiện có **ba mâu thuẫn nội bộ nằm đúng trên đường tiền và đường quyền**:

- **AD-6 ra lệnh ghi vào một bảng mà AD-5 đã dời đi, và AD-8 đã thu hồi quyền ghi.** Câu SQL được viết nguyên văn trong AD-6 hiện **không thể chạy** dưới chính chế độ quyền DB mà AD-8 vừa bắt buộc.
- **AD-9 tuyên bố chiều lệnh `realtime-gateway` → `api` "không tồn tại trong paradigm", trong khi AD-16 và AD-22 đều đòi đúng chiều đó.**
- **AD-22 giao `room_reservations` cho `api` rồi bảo `realtime-gateway` dọn dẹp nó** — vi phạm trực diện luật một-chủ-ghi của AD-8, và không khớp với bảng `GRANT` mà AD-8 vừa dựng.

Ba cái đó không phải bắt bẻ câu chữ: chúng là loại mâu thuẫn mà hai đơn vị một tầng dưới sẽ giải quyết theo hai hướng khác nhau, ở đúng chỗ có tiền.

Song song, **bốn chiều vẫn im lặng hoàn toàn** — không quyết, không hoãn, không nêu thành câu hỏi mở: xác thực ở ranh giới WebSocket, kênh lệnh giữa hai process, ranh giới input AI (prompt-injection, gap H4 mà PRD §10 gọi đích danh), và rate limit / chống lạm dụng. Theo checklist thì mỗi chiều im lặng là một finding, và ba trong bốn cái này là mặt tấn công.

Cuối cùng, một quan sát về **hình dạng**: spine đã đi từ 20 lên 23 AD với nhiều AD mang hai đến ba Rule. Nó vẫn chưa phình thành solution design, nhưng phần **Seed** giờ đã lệch khỏi phần **Invariants** (sơ đồ thực thể không có `user_balances`, `reputation_scores`, `room_reservations`), và **Capability Map đã lỗi thời so với chính các AD mới**. Tài liệu tự mâu thuẫn tệ hơn tài liệu thiếu.

---

## Verdict theo từng chiều của checklist

| Chiều | Verdict | Ghi chú một dòng |
| --- | --- | --- |
| Bịt đúng điểm phân kỳ của tầng dưới, không sót | **adequate** | Cải thiện lớn nhờ AD-21/22/23. Còn sót: kênh lệnh nội bộ, auth WS, chống lạm dụng, ranh giới AI |
| Rule có **cưỡng chế** được và thật sự chặn đúng divergence nó khai | **thin** | AD-1/5/8/12/15/20/22 là cưỡng chế máy thật và rất tốt. Nhưng AD-6 hiện **không chạy được**, AD-9 mâu thuẫn AD-16/22, AD-10 và AD-11 vẫn là lời khuyên khoác áo luật |
| Deferred có chỗ nào để hai đơn vị lệch | **thin** | Lý do hoãn embedding **sai về mặt kỹ thuật**; "framework test" mâu thuẫn AD-6; Stack trỏ Redis/Valkey sang Deferred mà Deferred **không có dòng đó** |
| Phủ capability của nguồn (19 US) | **adequate** | 19/19 có dòng, nhưng ba AC chịu lực không có AD nào đỡ: US-0.4 AC2, US-2.4 AC5/AC6, và NFR § Chống tấn công |
| Chiều nào bị **im lặng** (đặc biệt envelope vận hành) | **thin** | CI đã vá. Còn im lặng: auth ranh giới WS · kênh lệnh xuyên process · ranh giới input AI · rate limit · thứ tự migration/deploy · vòng đời dữ liệu người dùng · vai trò Redis |
| Seed đội lốt invariant / over-specification | **adequate** | Độ dài tổng thể vẫn đúng và đáng khen. Nhưng Seed và Capability Map đã **lỗi thời** so với AD-5/8/21/22 — bloat sai còn tệ hơn bloat |
| Công nghệ đã kiểm hiện hành | **strong** | Vòng versions đã làm tốt: TS 7 + shim TS 6 cho `nest build` là chi tiết thật, không phải trí nhớ. Trừ một dòng còn "**chưa chốt**" trong spine `status: final` |
| Ratify brownfield / không mâu thuẫn parent spine | **n/a** | Greenfield, không có parent spine |

---

## Findings

Thang: **critical** (spine tự mâu thuẫn hoặc không build đúng được nếu không sửa) · **high** (sẽ hỏng ở production, hoặc để hở mặt tấn công) · **medium** (hai đơn vị lệch được, hậu quả sửa được) · **low** (chính xác / gọn gàng).

---

### F-01 · [critical] AD-6 ra lệnh ghi vào bảng mà AD-5 đã dời đi và AD-8 đã thu hồi quyền

**Chỗ đứng:** AD-6 § Rule vs AD-5 § Rule (bảng riêng) vs AD-8 § Rule (cưỡng chế bằng quyền DB).

Ba AD nói ba chuyện không khớp nhau về **cùng một câu lệnh**, là câu lệnh quan trọng nhất trong hệ:

- **AD-5** (mới) dời số dư ra bảng riêng: *"số dư sống ở bảng **`user_balances` riêng**, không phải một cột trong `users`"* — và lập luận cho việc dời rất đúng (ORM `save(user)` ở `api` sẽ ghi đè một lần trừ).
- **AD-8** (mới) cưỡng chế bằng `GRANT`: *"role của `realtime-gateway` **không có** `UPDATE` trên `users`"*.
- **AD-6** (chưa cập nhật) vẫn viết nguyên văn: `UPDATE users SET balance = balance − :amt WHERE id = :u AND balance >= :amt`.

Ghép ba cái lại: câu lệnh mà AD-6 bắt buộc phải dùng **chạy trên bảng không còn cột đó**, và **do một role không có quyền `UPDATE` trên bảng đó** thực thi. Nó không chỉ lỗi thời — nó bị chính spine cấm.

Nghiêm trọng ở chỗ AD-6 là AD mà `review-adversarial.md` §6 đã phải siết một lần rồi, và là một trong bốn cổng CI của AD-20 (*"test hợp đồng adapter của AD-6"*). Một đội đọc AD-6 theo nghĩa đen sẽ viết adapter chết ngay lần chạy đầu; một đội "đoán ý" sẽ tự sửa sang `user_balances` — và bộ test hợp đồng dùng chung sẽ được viết theo bên nào tự sửa trước.

**Fix đề xuất:** cập nhật câu lệnh trong AD-6 thành `UPDATE user_balances SET balance = balance − :amt WHERE user_id = :u AND balance >= :amt`, và thêm một câu nói rõ rằng hình dạng câu lệnh (điều kiện nằm trong `WHERE`, không nằm trong code) mới là bất biến — tên bảng là seed. Đây cũng là lời nhắc chung: khi một AD nhắc tên bảng cụ thể, nó đã trộn seed vào invariant và sẽ lỗi thời đúng kiểu này.

---

### F-02 · [critical] AD-9 tuyên bố một chiều liên lạc "không tồn tại", trong khi AD-16 và AD-22 đều đòi đúng chiều đó

**Chỗ đứng:** AD-9 § Rule (ai cấp) vs AD-16 § Rule vs AD-22 § Rule.

AD-9 (mới) chốt: *"**Không có lời gọi lệnh nào đi từ `realtime-gateway` ngược sang `api` — chiều đó không tồn tại trong paradigm.**"*

Nhưng hai AD khác đòi chính xác chiều đó:

- **AD-16:** *"`realtime-gateway` kết thúc mọi phiên đang chạy, chốt sổ block cuối, **báo lại** → `api` mới đóng hẳn."* "Báo lại" là một lời gọi từ `rtg` sang `api`. Không có nó, giao thức ba nhịp của AD-16 đứng ở nhịp hai vĩnh viễn.
- **AD-22:** *"`realtime-gateway` **giải phóng chỗ giữ đã hết hạn** khi đối chiếu với hiện diện thật."* Chỗ giữ nằm trong `room_reservations`, bảng mà chính AD-22 giao cho `api`.

Ba AD, ba câu, hai chiều liên lạc loại trừ nhau. Một đội đọc AD-9 sẽ cài AD-16 bằng cách cho `api` **polling** trạng thái phiên (chậm, tốn, và không có mốc "đã chốt sổ xong" đáng tin); một đội đọc AD-16 sẽ mở một đường gọi ngược mà AD-9 vừa cấm. Cả hai "đúng spine".

Lưu ý thêm: ý định đằng sau AD-9 là tốt và đáng giữ — nó bảo *quyết định kết nạp* không được đi vòng qua process khác. Vấn đề là nó phát biểu quá rộng, thành ra cấm luôn cả *thông báo hoàn tất* và *dọn dẹp*, là hai thứ khác hẳn.

**Fix đề xuất:** thu hẹp phát biểu của AD-9 về đúng cái nó muốn: *"Không process nào xin process kia ra **quyết định kết nạp** thay mình"*. Rồi để F-03 (dưới đây) định nghĩa một kênh sự kiện hai chiều tường minh, và viết lại AD-16/AD-22 để cả hai đi qua kênh đó.

---

### F-03 · [critical] Kênh lệnh giữa hai process vẫn không tồn tại như một quyết định

**Chỗ đứng:** AD-8, AD-13, AD-16, AD-18, AD-22.

Spine hiện gọi tới một đường lệnh xuyên process ở **bốn** chỗ, mỗi chỗ một chiều, và **không chỗ nào** nói lệnh đó đi bằng gì:

| Chỗ | Chiều | Lệnh |
| --- | --- | --- |
| AD-8 (nạp coin) | `api` → `rtg` | *"phát một lệnh ghi có khoá idempotent"* |
| AD-18 (thu hồi quyền) | `api` → `rtg` | *"phải đẩy được lệnh thu hồi"* |
| AD-16 (đóng phòng) | `rtg` → `api` | *"báo lại"* |
| AD-22 (chỗ giữ hết hạn) | `rtg` → `api` | *"giải phóng chỗ giữ"* |

AD-13 quy định *hình dạng payload* qua ranh giới process, không quy định *đường đi* và **không quy định ngữ nghĩa giao hàng**.

Đây là chỗ mà tính nhất quán nội bộ của spine trở nên mỉa mai: **AD-2 loại LiveKit data channel khỏi đường tiền với lý do chính xác là "giao hàng chỉ là best-effort"**, và **AD-3 (Rule mới) loại webhook khỏi vai trò thẩm quyền với đúng lý do đó** — hai lập luận rất tốt. Rồi spine để ngỏ hoàn toàn một đường truyền nội bộ mang lệnh **nạp coin** và lệnh **ban**, tức là chính hai thứ mà best-effort không được phép chạm vào.

**Hai đơn vị lệch thế nào:** đội làm US-4.2 chọn HTTP nội bộ đồng bộ (at-most-once: `rtg` đang restart — chuyện mà AD-4 đã lường trước — thì lệnh nạp coin bốc hơi, người dùng trả tiền thật mà không nhận coin). Đội làm US-3.4/US-0.5 chọn Redis pub/sub (fire-and-forget: lệnh ban không tới nơi, người bị ban tiếp tục kiếm coin giữa phiên — đúng lỗ hổng AD-18 sinh ra để bịt).

**Fix đề xuất — AD mới, "Lệnh xuyên process đi qua outbox trong DB, at-least-once":**
> Không có lời gọi trực tiếp process-to-process nào mang hệ quả tiền hoặc quyền. Bên phát ghi một dòng vào `outbox` **trong cùng transaction** với thay đổi sinh ra nó (thanh toán đã xác nhận, lệnh ban đã ghi, phiên đã chốt sổ); bên nhận tiêu thụ và đánh dấu đã xử lý. Giao hàng là **at-least-once**, nên mọi handler phải idempotent theo khoá của AD-19. Một lệnh chưa xử lý không bao giờ biến mất vì một process restart. Chiều nào cũng được phép — cái bị cấm (AD-9) là **xin quyết định**, không phải **báo sự kiện**.

Chọn outbox thay vì broker cũng đóng luôn câu hỏi "cần Redis để làm gì" (F-13) và tái dùng đúng transaction mà AD-5 đã bắt buộc.

---

### F-04 · [high] AD-22 giao `room_reservations` cho `api` rồi bảo `realtime-gateway` dọn — vi phạm AD-8

**Chỗ đứng:** AD-22 § Rule vs AD-8 § Rule (bảng chủ ghi) và § Rule (cưỡng chế bằng quyền DB).

AD-22 viết: *"`api` **sở hữu** bảng `room_reservations` của riêng nó ... `realtime-gateway` **giải phóng chỗ giữ đã hết hạn** khi đối chiếu với hiện diện thật."*

Đó là hai chủ ghi trên một bảng — chính xác điều AD-8 tồn tại để cấm, và điều AD-8 vừa mới siết bằng `GRANT`. Tệ hơn, bảng `room_reservations` **không xuất hiện** trong bảng chủ ghi của AD-8 lẫn trong danh sách `GRANT`, nên không ai biết role nào có quyền gì trên nó. Chính AD-8 vừa thêm Rule *"bảng chủ ghi phải phủ **mọi** bảng ... **một bảng không có chủ là một bảng có hai chủ**"* — và bảng mới nhất của spine đã rơi đúng vào cái bẫy đó, ngay trong cùng một vòng vá.

Hậu quả cụ thể không nhỏ: đây là bảng cưỡng chế trần gói (US-1.2 AC3, US-4.1 AC2). Hai bên cùng ghi thì `api` có thể cấp token trong lúc `rtg` đang dọn cùng những hàng đó, và trần lại hở đúng theo cách AD-22 sinh ra để đóng.

**Fix đề xuất:** giữ `api` là chủ ghi duy nhất và bỏ vai trò dọn dẹp của `rtg`. Chỗ giữ tự hết hạn bằng **thời gian** (`expires_at`, cùng độ dài với TTL của token AD-9), và phép đếm trong `INSERT` có điều kiện của AD-22 chỉ đếm chỗ giữ **chưa hết hạn** — không cần ai đi dọn cả. Nếu vẫn muốn đối chiếu với hiện diện thật, `rtg` **phát sự kiện** qua kênh của F-03, còn `api` mới là bên ghi.

---

### F-05 · [high] AD-21 tách phiên thành phòng LiveKit thứ hai nhưng không định nghĩa lại `joined_at` — mốc bắt đầu tính tiền

**Chỗ đứng:** AD-21 (mới) vs AD-4 (mới), AD-7, AD-23.

AD-21 là quyết định đúng và lập luận sắc (không tách phòng thì `participant_left` không phân biệt được "rời phiên" với "rời phòng", và AD-3 mất tín hiệu liveness). Nhưng nó **đổi ý nghĩa của một biến mà AD-4 vừa mới neo tiền vào**.

AD-4 giờ tính `block_index = floor((now − participant.joined_at) / block_size)`. Với AD-21, "vào phiên" không còn là một sự kiện mà là **một chuỗi**: bấm xác nhận → `rtg` cấp token phòng phiên → client kết nối phòng LiveKit thứ hai → LiveKit báo `participant_joined` → có audio thật. Giữa đầu và cuối chuỗi đó có thể là vài giây — và với người dùng mục tiêu của PRD (Trâm, wifi phòng trọ chập chờn, ngân sách p90 5 giây cho **một** lần vào phòng) thì "vài giây" là con số thật, không phải lý thuyết.

**Hai đơn vị lệch thế nào:** đội A đặt `joined_at` lúc chấp nhận phiên (người dùng bị tính tiền cho 4 giây đang kết nối — phá luật *"không có gì trừ coin mà không qua thẻ xác nhận"* của `EXPERIENCE.md`, vì thẻ nói giá theo phút nghe giảng, không phải theo phút chờ WebRTC bắt tay). Đội B đặt lúc LiveKit báo tham gia (mở ra một khe: kết nối chậm có chủ đích để né block đầu — đúng loại khe hở mà AD-7 sinh ra để đóng). Cả hai đều tuân thủ đủ 23 AD.

Kèm theo: AD-21 làm **mỗi người giữ hai kết nối LiveKit đồng thời**. Ngân sách TURN/coturn và số kết nối đồng thời của lớp Campus 45–100 vì thế nhân đôi ở kịch bản xấu — spine không nói gì, và đây là thứ ảnh hưởng tới việc chọn kích thước VPS.

**Fix đề xuất:** một câu vào AD-4 hoặc AD-21 — `joined_at` là **thời điểm LiveKit xác nhận participant có mặt trong phòng phiên**, kéo về bằng cơ chế "kéo, không đẩy" mà AD-3 đã dựng. Thời gian bắt tay do người dùng chịu là **0**. Để chặn khe hở né block, token phòng phiên có TTL ngắn (AD-9 đã ngắn hạn sẵn): không kết nối kịp thì phải xin lại, không phải được học miễn phí. Thêm một dòng vào Seed § Triển khai ghi nhận hệ số nhân đôi kết nối do AD-21.

---

### F-06 · [high] Xác thực ở ranh giới WebSocket của `realtime-gateway` vẫn bị bỏ trắng

**Chỗ đứng:** Conventions § Auth, AD-9, AD-8.

Bảng Conventions nói đúng hai câu về danh tính: *"Web dùng session cookie httpOnly + secure. Token LiveKit là JWT ngắn hạn riêng cho một lần vào phòng (AD-9)."* AD-9 (kể cả sau khi thêm Rule "ai cấp") chỉ nói về **token vào phòng LiveKit**.

Không câu nào trả lời: **`apps/realtime-gateway` biết người đang mở WebSocket tới nó là ai bằng cách nào, và tin điều đó dựa trên gì?**

Đây không phải chi tiết cài đặt. Theo AD-8, `realtime-gateway` là chủ ghi của **sổ cái coin, số dư, vòng đời phiên, và `reputation_scores`**. Nó là mặt phẳng có tiền. Một ranh giới không được đặc tả ở đó là mặt tấn công lớn nhất trong hệ — và spine vừa dành ba AD mới để bảo vệ mặt phẳng đó khỏi những kịch bản khó hơn nhiều.

**Hai đơn vị lệch thế nào:** đội `api` cài session cookie đúng chuẩn. Đội `rtg` — process riêng, có thể khác cổng, và cookie `SameSite` với WebSocket hành xử khác request thường — chọn cách dễ nhất: nhận `user_id` trong message đầu tiên và tin nó. Không AD nào cấm. Toàn bộ AD-3 khi đó thành vô nghĩa: client không cần nói dối về trạng thái audio nữa, nó chỉ cần nói dối về **mình là ai**.

Liên đới: AD-18 đòi thu hồi quyền được — nếu WS auth là token tự chứa dài hạn thì "thu hồi" cần danh sách đen mà spine không nói. Và `EXPERIENCE.md § State Patterns` có hẳn trạng thái *"Phiên hết hạn giữa buổi học"*, nghĩa là hết hạn phải lan tới **cả hai** process một cách nhất quán.

**Fix đề xuất — AD mới, "Một nguồn danh tính duy nhất cho cả hai vỏ":**
> `apps/api` là bên duy nhất phát hành danh tính người dùng. `realtime-gateway` **không bao giờ** nhận danh tính từ payload của client: mỗi kết nối WS phải trình một token ngắn hạn do `api` cấp (cùng cơ chế AD-9, khác audience), gateway xác thực **trước** khi nhận message đầu tiên và gắn `user_id` từ token vào mọi lệnh ghi. Token hết hạn giữa phiên thì gateway hạ kết nối và client xin token mới — việc đó **không** làm gián đoạn phiên đang tính tiền, vì AD-23 đã có `suspended` để diễn đạt đúng khoảng đó.

---

### F-07 · [high] Ranh giới input AI / prompt-injection bị bỏ trắng hoàn toàn

**Chỗ đứng:** không AD nào. `docs/prd.md` US-0.4 AC2, US-3.1 AC3, NFR Bảo mật (H4), §10.

PRD yêu cầu điều này ở **ba** chỗ độc lập:
- US-0.4 AC2: *"Middleware prompt-injection scan cho mọi input đi vào AI"*
- US-3.1 AC3: *"Input đi qua prompt-injection scan trước khi vào AI (H4)"*
- NFR Bảo mật (H4): *"Prompt-injection scan input AI; ...; **sandbox+timeout tác vụ**"*

Và PRD §10 liệt kê *"kế hoạch đóng gap CASAN H4/H5/H6"* là một đầu ra mong đợi **của chính tài liệu Architecture**.

Spine: không quyết, không hoãn, không nêu thành câu hỏi mở. Capability Map ánh xạ US-3.1 sang *"`apps/api` + pgvector, governed by **AD-13**"* — AD-13 là hợp đồng `/v1`, không liên quan gì tới lọc input. Đây là **một chiều bị im lặng** theo đúng nghĩa của checklist.

**Hai đơn vị lệch thế nào:** ô "nguyện vọng" của US-3.1 và mọi đường AI thêm sau (gợi ý lớp, lọc nội dung chat US-1.4 AC2) mỗi cái tự cài một bộ lọc riêng ở một tầng khác nhau — controller / service / không có. Và *"sandbox + timeout"* của H4 hoàn toàn vắng mặt: một lời gọi embedding treo 60 giây khoá request path của `api`, tức là khoá luôn đường cấp token của AD-9/AD-22 — đường nóng mang ngân sách p90 5 giây.

**Fix đề xuất — AD mới, "Mọi input người dùng vào AI đi qua đúng một cổng":**
> Tồn tại đúng một port `ai.embed()` / `ai.invoke()` khai trong `packages/domain`; không đường code nào gọi thẳng SDK nhà cung cấp AI từ `apps/*` (cưỡng chế bằng cùng cổng kiểm phụ thuộc của AD-20). Cổng đó áp **quét prompt-injection**, **giới hạn độ dài input**, và **timeout cứng** trước khi gọi ra ngoài — cả ba là thuộc tính của cổng, không phải trách nhiệm của bên gọi. Thêm một tính năng AI là thêm một lời gọi qua cổng, không phải thêm một bộ lọc mới.

---

### F-08 · [high] Không có AD nào chặn rò rỉ dữ liệu **suy ra được** qua payload

**Chỗ đứng:** AD-15 (chỉ phủ log). `docs/prd.md` US-2.4 AC5/AC6, `EXPERIENCE.md § Luật coin & tiền` + § Microcopy.

`EXPERIENCE.md` và PRD nói rõ, và nói **hai lần**, rằng ba thứ không được lộ:

1. đang hỏi riêng **với ai** (lộ chuyện người kia đang trả coin — vi phạm chính giá trị ẩn danh);
2. **còn bao lâu** nữa xong — nguyên văn US-2.4 AC6: *"thời gian còn lại = số dư ÷ đơn giá, tức là lộ gián tiếp số dư coin"*;
3. **ai đã đồng ý / ai từ chối** một lời xin tham gia (US-2.4 AC5; `EXPERIENCE.md`: *"im lặng của một người sẽ bị đọc thành sự từ chối cá nhân"*).

Spine phủ **không cái nào**. AD-15 chỉ nói về log. AD-13 nói payload khai ở `packages/contracts` — nhưng *khai ở đâu* không quyết định *khai cái gì*.

**Đây là finding của spine, không phải của UX**, vì nó là ràng buộc lên **hình dạng dữ liệu qua ranh giới process**: `rtg` là bên phát trạng thái hiện diện/bận. Cách cài tự nhiên nhất là broadcast nguyên object phiên cho cả phòng và để client tự ẩn bớt. Lúc đó dữ liệu đã rời server — devtools mở ra là thấy số dư của người khác. Ẩn ở client là **lời khuyên**; hình dạng payload là **luật**.

AD-21 còn làm chuyện này cụ thể hơn: mỗi phiên giờ là một phòng LiveKit riêng, nên **danh sách participant của phòng đó chính là câu trả lời cho "đang hỏi riêng với ai"**. Ai cầm được token phòng phiên là đọc được. Đây là hệ quả riêng tư mới sinh ra từ AD-21 mà AD-21 chưa nhắc.

Đây cũng đúng loại "quiet requirement" mà `SKILL.md § Finalize` bước 2 (Reconcile inputs) tồn tại để bắt.

**Fix đề xuất — AD mới, "Suy ra được cũng là rò rỉ":**
> Payload trạng thái bận / hiện diện phát cho người **ngoài** một phiên chỉ chứa: người đó có đang trong một phiên hay không. **Không** danh tính người còn lại, **không** `session_id` hay id phòng LiveKit của phiên, **không** thời gian còn lại, **không** số block đã trôi, **không** `started_at` — hai cái sau suy ra số dư khi đơn giá đã công khai. Payload phản hồi lời xin tham gia chỉ mang trạng thái tổng hợp (`pending` / `accepted` / `declined` / `expired`), **không bao giờ** mang phiếu của từng người. Hết hạn 30 giây tính ở **server**, để "không phản hồi = từ chối" là một sự kiện, không phải một cách hiển thị.

---

### F-09 · [high] Rate limit và biên chống lạm dụng bị bỏ trắng ở cả hai process

**Chỗ đứng:** không AD nào. `docs/prd.md` NFR § Chống tấn công, US-0.1 AC3, US-1.4 AC1/AC2.

PRD đòi: *"Rate limit theo IP/user; WAF; chống DDoS ở gateway; khoá brute-force login"*, cộng US-0.1 AC3 và US-1.4 AC1 (chống spam chat). `EXPERIENCE.md § State Patterns` đặc tả hẳn trạng thái *"Bị rate-limit đăng nhập — 'Thử lại sau N giây', **đếm ngược thật**"*.

Spine: không quyết, không hoãn. Cả một chiều im lặng, và là chiều bảo mật.

**Vì sao là divergence chứ không chỉ thiếu tính năng:** có **hai** process và một reverse proxy — ba chỗ đặt được, và bộ đếm nằm ở đâu là quyết định thật:
- mỗi process tự đếm trong bộ nhớ → hai process cộng lại cho gấp đôi hạn mức, và mất sạch sau mỗi restart (mà `rtg` restart là chuyện AD-4 đã lường trước);
- đếm ở Caddy → chỉ theo IP, không theo user, nên US-0.1 AC3 và US-1.4 AC1 không cài được;
- đếm ở Redis → làm được, nhưng F-13 cho thấy Redis còn **chưa được chọn**, nói gì tới việc biết nó dùng làm gì.

Và *"đếm ngược thật"* là ràng buộc lên **hợp đồng lỗi** (Conventions § Hình dạng lỗi): client phải nhận số giây còn lại, không phải một 429 trần.

**Fix đề xuất — AD mới hoặc một dòng Conventions:**
> Rate limit là **shared state**, không phải trạng thái trong process: bộ đếm sống ở kho khoá-giá trị dùng chung với khoá `rl:<scope>:<subject>`; cả hai vỏ dùng chung một middleware trong `packages/`. Ba scope tối thiểu ở MVP: đăng nhập (IP + provider-id), gửi chat (user), gửi lời xin tham gia (user). Phản hồi vượt hạn mức dùng envelope lỗi chuẩn và **bắt buộc** mang số giây còn lại. WAF / chống DDoS ở tầng edge hoãn được; ba scope này thì không.

---

### F-10 · [high] AD-10 chưa được nâng lên chuẩn của AD-22 — trần 3 người vẫn là "kiểm rồi làm"

**Chỗ đứng:** AD-10 vs AD-22 (mới) và US-2.4 AC2.

AD-22 vừa phát biểu một quy tắc chung rất tốt: *"**một phép kiểm chỉ đọc là gợi ý, không phải cổng**"*, và bắt bên kiểm phải giữ chỗ nguyên tử. Nhưng AD-22 chỉ `Binds` S1/S4/US-1.2 AC3/US-4.1 AC2 — nó **không** được áp cho AD-10, và AD-10 vẫn nguyên văn cũ: *"Trần cưỡng chế trong `realtime-gateway` khi chấp nhận lời xin tham gia."*

Trần phiên có một đặc thù làm nó **dễ hở hơn** trần phòng: US-2.4 AC2 đòi **hai phiếu**, nên tồn tại một cửa sổ thời gian giữa phiếu thứ nhất và phiếu thứ hai — mặc định 30 giây theo `EXPERIENCE.md`. Hai lời xin song song, mỗi cái thu đủ hai phiếu trong cửa sổ của mình, cả hai cùng đọc "đang có 2 người" → phiên 4 người. Ghi chú chống lạm dụng của PRD US-2.3 (*"mức thu tối đa của một phiên là 1.000 coin/phút thay vì không giới hạn"*) bị vô hiệu, đúng cái `Prevents` mà AD-10 tự khai.

**Fix đề xuất:** thêm `US-2.3 AC5, US-2.4 AC7` vào `Binds` của AD-22 và siết AD-10 một câu — chấp nhận lời xin là một `INSERT` có điều kiện đếm vào `session_participants` (hoặc `UNIQUE(session_id, slot_index)` với 3 slot), không phải một phép đọc rồi một phép ghi. Đây cũng là chỗ trả lại tính nhất quán: spine đã dựng cả AD-6 và AD-22 quanh cùng một lập luận, không có lý do để AD-10 đứng ngoài.

---

### F-11 · [high] AD-11 là lời khuyên, không phải luật cưỡng chế được — và nó bảo vệ chính luận điểm của sản phẩm

**Chỗ đứng:** AD-11.

AD-11 có hai vế. Vế sau — *"Không có endpoint nào nhận ảnh khuôn mặt"* — cưỡng chế được và kiểm được (đọc danh sách route).

Vế trước — *"Ẩn mặt và filter xử lý hoàn toàn ở client trước khi khung hình vào WebRTC track. Server và LiveKit **không bao giờ** nhận được khung hình gốc"* — **không** cưỡng chế được như đang viết. Chế độ hỏng thực tế không phải "ai đó dựng endpoint nhận ảnh"; nó là: một dev sửa `apps/web` và publish thẳng `MediaStreamTrack` từ `getUserMedia()` thay vì track đã qua transform — trong một nhánh xử lý lỗi, khi mạng hồi phục (`EXPERIENCE.md` có hẳn luật *"không tự bật lại camera"* cho đúng tình huống này), hoặc khi tự hạ chất lượng filter theo US-2.1 AC3. Không gì trong spine chặn, không gì phát hiện, và LiveKit sẽ vui vẻ nhận.

AD-21 vừa làm bề mặt này **rộng gấp đôi**: giờ có hai phòng LiveKit để publish nhầm vào, và luồng "vào phiên" là một đường publish thứ hai được viết riêng.

AD này bảo vệ trực tiếp luận điểm §1.1 của PRD (*"nếu ẩn danh làm người dùng mất thứ gì, luận điểm sụp"*) và NFR Riêng tư. Nó xứng đáng có đúng độ cưỡng chế mà AD-1 được cấp.

**Fix đề xuất — siết Rule của AD-11:**
> Trong `apps/web` tồn tại **đúng một** hàm trả về track được phép publish; nó luôn trả đầu ra của pipeline transform, kể cả ở chế độ "Để nguyên", và **dùng chung cho cả hai phòng LiveKit của AD-21**. Track thô từ `getUserMedia()` không bao giờ được truyền cho SDK LiveKit — cưỡng chế bằng lint rule cấm gọi `publishTrack` / `setCameraEnabled` ngoài module đó, và đưa vào cổng CI của AD-20 (cổng thứ năm, cạnh cổng kiểm chiều phụ thuộc AD-1).

---

### F-12 · [medium] Luật dưới-18 chỉ gắn vào cửa token, không gắn vào đường ghi sổ cái

**Chỗ đứng:** AD-9, Capability Map (US-0.5) vs `docs/prd.md` US-0.5 AC2/AC4, AD-19.

US-0.5 AC2 đòi *"chặn cứng ở tầng API, **không chỉ ẩn nút**: ... **không nhận được coin từ người dùng khác**"*. AC4 cho phép chiều ngược lại — người dưới 18 **vẫn tiêu** coin — và coin do **hệ thống** cấp (`system_grant`, `reputation_reward`) **không** bị chặn.

Nghĩa là luật này là một vị từ trên **từng dòng sổ cái**, phụ thuộc `source` của AD-19 và tuổi người nhận. Nhưng: sổ cái do `rtg` ghi (AD-8); tuổi do `api` sở hữu (AD-8); AD-9 kiểm tuổi ở **thời điểm cấp token vào phòng**, không phải lúc ghi tín dụng; Capability Map ánh xạ US-0.5 sang `apps/api` + AD-9/AD-15, không AD nào phủ đường ghi.

Cửa chặn duy nhất còn lại là "không bật được nhận hỏi riêng" — một cửa, ở API. Đúng cái mà AC2 nói là không đủ. Và nó không phòng thủ được trường hợp người dùng đủ 18 lúc bật rồi bị phát hiện khai gian tuổi (US-0.5 AC6) giữa phiên — kịch bản mà AD-18 vừa được siết để xử lý.

**Fix đề xuất:** phát biểu luật ở nơi cưỡng chế được — trong `packages/domain`, như vị từ trên hàm ghi sổ cái: dòng tín dụng có `source ∈ {session_tick, topup}` bị từ chối nếu người nhận chưa đủ 18; `system_grant` và `reputation_reward` thì không. Ghi vào AD-19 (nơi `source` đã sống) và cập nhật Capability Map cho US-0.5.

---

### F-13 · [medium] Dòng Stack "Redis 8 hoặc Valkey 9 — **chưa chốt** — xem Deferred" trỏ vào một mục Deferred không tồn tại

**Chỗ đứng:** § Stack vs § Deferred; và vai trò của Redis vẫn không được định nghĩa ở đâu cả.

Ba vấn đề chồng lên nhau trong một dòng:

1. **Tham chiếu gãy.** Dòng Stack bảo "xem Deferred". Bảng Deferred có chín dòng và **không dòng nào** về Redis/Valkey. Người đọc đi tìm quyết định và không tìm thấy gì.
2. **Một hạng mục chưa chốt trong spine `status: final`.** Đây không phải hoãn có chủ đích được ghi ra — nó là một ô trống. Lý do nêu (Redis 7.4 EOL 30/11/2026, Redis 8 đổi sang AGPLv3) là nghiên cứu tốt và đáng giữ, nhưng nó là *dữ liệu để quyết*, không phải *quyết định*.
3. **Vai trò vẫn không ai định nghĩa.** Sơ đồ bối cảnh nối **cả** `api` **và** `rtg` vào Redis, nhưng không dòng nào trong Invariants hay Conventions nói Redis chứa gì, ai ghi gì, khoá đặt tên thế nào, và — quan trọng nhất — **dữ liệu trong đó có phải nguồn sự thật không**. Với một hệ mà AD-5 dựng cả lập luận quanh "sổ cái là nguồn sự thật", để một kho dữ liệu thứ hai không phân loại là mâu thuẫn đang chờ xảy ra: cách cài nhanh nhất cho "ai đang trong phòng" hay "chỗ giữ của AD-22" là nhét vào Redis — rồi Redis restart, và AD-8, AD-22, AD-23 mất nền dữ liệu.

Ghi chú: AGPLv3 của Redis 8 là vấn đề **giấy phép**, không phải vấn đề kỹ thuật, và nó chạm tới câu hỏi sản phẩm sẽ phân phối thế nào. Đó là loại quyết định phải nêu ra cho chủ dự án, không nên để im trong một ô bảng.

**Fix đề xuất:** (a) chốt một cái — Valkey 9 nếu muốn tránh AGPL, Redis 8 nếu không bận tâm — hoặc chuyển thành một dòng Deferred **thật** có điều kiện quay lại rõ ràng; (b) thêm một dòng Conventions: *"Kho khoá-giá trị là **cache và bộ đếm phù du**, không bao giờ là nguồn sự thật. Mọi thứ mất khi nó mất phải dựng lại được từ Postgres. Không trạng thái nào của tiền, quyền, hay vòng đời phiên sống duy nhất ở đó. Khoá đặt theo tiền tố có chủ: `rl:`, `presence:`, `cache:`."*

---

### F-14 · [medium] Hai process dùng chung một DB nhưng không có luật về ai chạy migration và theo kỷ luật nào

**Chỗ đứng:** Conventions § Migration, AD-20 vs sơ đồ Triển khai, và AD-8 § Rule (quyền DB).

Conventions nói *"Chỉ tiến, không lùi. Mỗi migration chạy được trên DB đang có dữ liệu mà không khoá bảng lâu."* AD-20 thêm một cổng CI. Cả hai đúng và cả hai **không** trả lời hai câu mà kiến trúc hai-process-một-DB bắt buộc phải trả lời:

1. **Ai chạy migration?** Cả `api` lẫn `rtg` đều phụ thuộc `packages/db`. Mặc định của mọi framework là migrate lúc khởi động. Hai container cùng lên trong một `docker compose up` → hai process cùng migrate → race hoặc lock hoặc một bên chết. Bug kinh điển, và nó **chắc chắn** xảy ra ở lần deploy đầu. Câu hỏi này còn gắt hơn sau AD-8: nếu mỗi process có DB role riêng và bị thu hồi quyền ghi trên bảng của bên kia, thì **role nào có quyền `ALTER`?** Không role nào trong bảng `GRANT` của AD-8 có quyền đó. Migration hiện không có chủ.
2. **Migration có phải tương thích ngược với bản đang chạy không?** "Chỉ tiến, không lùi" nói về *hướng*, không nói về *tương thích*. Giữa lúc migration chạy và lúc process thứ hai được thay, code cũ vẫn chạy trên schema mới. Đổi tên một cột → process chưa deploy chết. Và process đó có thể chính là cái đang tính tiền.

Spine đã có sẵn khuôn tư duy đúng: AD-16 nói *"thực thể của một chủ không được biến mất khi thực thể sống của chủ kia đang phụ thuộc vào nó"* — đó chính là expand/contract, chỉ chưa được áp cho schema.

**Fix đề xuất — hai dòng vào Conventions § Migration:**
> Migration chạy bằng **một job riêng với role riêng có quyền DDL**, trước khi bất kỳ app container nào khởi động; không app nào tự migrate lúc boot, và role của hai vỏ **không có** quyền DDL. Mọi migration phải **tương thích ngược với bản deploy liền trước** (expand ở lần này, contract ở lần sau). Nhánh sau của AD-16 áp cho schema y như cho thực thể.

---

### F-15 · [medium] `now` trong công thức AD-4 vẫn không có nguồn đồng hồ

**Chỗ đứng:** AD-4.

`block_index = floor((now − participant.joined_at) / block_size)`. `joined_at` giờ đã được neo (tốt). `now` thì vẫn không.

Ba nguồn khả dĩ, spine không chọn: giờ process Node (`Date.now()`), giờ DB (`now()` trong chính câu `INSERT`), hoặc đồng hồ đơn điệu nội bộ scheduler. Ba hệ quả khác nhau:
- giờ process trôi so với giờ DB → `block_index` nhảy hoặc lặp qua một lần restart, và cái cứu là `UNIQUE` của AD-4 chứ không phải tính đúng;
- NTP chỉnh giờ lùi giữa phiên → `block_index` **giảm**, tick kế bị `UNIQUE` từ chối, phiên đứng im mà **không có lỗi** — đúng chế độ hỏng mà Deferred § quan trắc gọi là tệ nhất của hệ thống này;
- client tính đồng hồ hiển thị bằng giờ máy nó (lệch tuỳ máy) → con số trên màn không khớp con số bị trừ, phá luật *"mọi câu nói về tiền phải chứa con số"* của `EXPERIENCE.md`.

AD-3 nói đồng hồ client "là ảnh phản chiếu, không có quyền quyết định gì" — nhưng nó vẫn phải phản chiếu **đúng**, và spine không cho nó nguồn để đồng bộ. AD-23 làm chuyện này gắt hơn: `joined_at` **hiệu dụng bị dịch** mỗi lần ra/vào `suspended`, nên client không thể tự suy ra mốc block nữa.

**Fix đề xuất:** một câu vào AD-4 — `now` là giờ của **Postgres**, lấy trong cùng câu lệnh ghi sổ cái (nguồn duy nhất, không phụ thuộc process nào đang tick). Server phát **mốc thời gian tuyệt đối của ranh giới block kế tiếp** cho client; client đếm ngược tới mốc đó thay vì tự cộng dồn — và phát lại mốc mới mỗi lần rời `suspended`.

---

### F-16 · [medium] Lý do hoãn embedding provider **sai về mặt kỹ thuật**

**Chỗ đứng:** § Deferred, dòng "Chọn nhà cung cấp embedding cho US-3.1".

Spine viết: *"pgvector cố định phía lưu trữ; **nguồn sinh vector đổi được mà không đụng schema**."*

Không đúng. Cột `vector` của pgvector khai với **số chiều cố định** (`vector(1536)`), và mỗi mô hình embedding có số chiều riêng — 768, 1024, 1536, 3072 đều phổ biến. Đổi nhà cung cấp (hoặc chỉ đổi mô hình của cùng nhà cung cấp) thường **là** một migration schema, cộng **sinh lại toàn bộ vector** cho mọi phòng đã có, cộng dựng lại index. Và ngay cả khi số chiều tình cờ trùng, vector của hai mô hình khác nhau **không so sánh được với nhau** — trộn hai thế hệ trong một bảng cho ra similarity vô nghĩa mà **không hề báo lỗi**, tức là hỏng câm.

`review-rubric.md` trước đó đã ghi mục Deferred này vào cột "đạt" (*"embedding provider bị pgvector cô lập"*) — kết luận đó dựa trên cùng giả định sai. Đây là một mục Deferred **thật sự để hai đơn vị lệch**: cái được coi là "đã cô lập" thì không hề được cô lập.

**Fix đề xuất — viết lại dòng Deferred kèm ràng buộc không hoãn được:**
> Hoãn chọn nhà cung cấp, nhưng **không hoãn**: (a) `room_embeddings` mang cột `model_id` và `dim`; (b) truy vấn similarity luôn lọc theo `model_id` — không bao giờ so vector của hai mô hình; (c) đổi mô hình là một **backfill có version**, không phải đổi một biến môi trường.

---

### F-17 · [medium] Mục Deferred "framework test" mâu thuẫn trực tiếp với AD-6 và AD-20

**Chỗ đứng:** § Deferred (dòng CI/test) vs AD-6 § Rule (port), AD-20.

AD-6 đòi *"một **bộ test hợp đồng dùng chung**"* mà **mọi** adapter phải qua. AD-20 biến nó thành cổng CI bắt buộc — một trong bốn cổng. Rồi Deferred nói *"nền tảng CI cụ thể **và framework test**"* hoãn được, với carve-out chỉ nhắc lại ràng buộc chứ không gỡ mâu thuẫn.

Một bộ test **dùng chung** giữa adapter Postgres (`packages/db`) và adapter in-memory (dùng cho test `domain`) chỉ tồn tại nếu cả hai chạy trên **cùng một runner**, cùng hình dạng assertion, cùng cách khai suite. Hoãn "framework test" là hoãn đúng cái làm AD-6 khả thi. Hai đội chọn hai runner → có hai bộ test hợp đồng, tức là **không có** bộ nào dùng chung, tức là AD-6 mất hiệu lực đúng ở chỗ nó khai `Prevents` (*"một adapter quên điều kiện vẫn tuân thủ đủ mọi AD"*).

**Fix đề xuất:** tách hai thứ đang bị gộp — hoãn *nền tảng CI* và hoãn *chiến lược test E2E/UI* thì được; **chốt một runner duy nhất cho test đơn vị và test hợp đồng của toàn monorepo ngay bây giờ**, vì đó là điều kiện tồn tại của AD-6 và của cổng thứ ba trong AD-20.

---

### F-18 · [medium] Không nói `realtime-gateway` là đơn thể, trong khi AD-3, AD-16, AD-22, AD-23 đều giả định điều đó

**Chỗ đứng:** AD-3, AD-16, AD-22, AD-23, § Deferred (dòng autoscale).

AD-3: *"Scheduler trong `apps/realtime-gateway` là **nguồn duy nhất** phát nhịp trừ coin."* Đúng ở cấp *module*, im lặng ở cấp *instance*. Deferred lại nói autoscale hoãn được — nghĩa là về sau ai đó hoàn toàn có thể `--scale realtime-gateway=2` mà không vi phạm chữ nào.

Về tiền thì AD-4 cứu được (`UNIQUE` chặn tick trùng) — thiết kế tốt, đáng khen. Nhưng bốn thứ khác không được cứu, và ba trong số đó **mới xuất hiện ở vòng vá này**:
- **kết thúc phiên**: hai scheduler cùng thấy "không đủ số dư", cùng chạy luồng kết thúc → hai thẻ tổng kết, hai lần chốt sổ;
- **AD-23**: chuyển `suspended → ended` khi hết cửa sổ 30 giây — instance nào chịu trách nhiệm hết hạn? Hai instance thì hết hạn hai lần;
- **AD-22**: *"`rtg` giải phóng chỗ giữ đã hết hạn"* — hai instance cùng dọn;
- **AD-16**: `api` đợi *"`rtg` báo lại"* — báo từ instance nào là đủ? Cộng thêm WebSocket cần dính phiên hoặc một lớp fan-out mà spine chưa có.

**Fix đề xuất:** một câu vào AD-3 — trong MVP `realtime-gateway` chạy **một instance duy nhất**, và đó là ràng buộc được ghi ra chứ không phải sự tình cờ của compose. Dòng Deferred về autoscale phải nêu điều kiện quay lại: nhiều hơn một instance đòi **leader election cho scheduler và cho mọi tác vụ hết hạn** cộng fan-out cho WS — không phải chỉ đổi con số replica.

---

### F-19 · [medium] Vòng đời dữ liệu người dùng bị bỏ trắng, và spine tự tạo ra căng thẳng cho nó

**Chỗ đứng:** AD-5, AD-12, AD-15; `docs/prd.md` US-0.5 AC5, NFR Riêng tư.

Spine chốt hai bảng **append-only**: sổ cái coin (AD-5, được gọi thẳng là *"bản ghi tài chính"* trong Deferred) và `audit_events` (AD-12, *"không có đường `UPDATE` hay `DELETE` trong code"*). Đồng thời hệ thống lưu **ngày sinh** (PII rõ ràng theo PRD §1.3), email và provider-id từ OAuth.

Câu hỏi "người dùng xoá tài khoản thì chuyện gì xảy ra" chưa từng được hỏi — không quyết, không hoãn, không nêu thành câu hỏi mở. Nhưng chính hai AD trên làm nó **khó**: không thể `DELETE FROM users` khi sổ cái và audit tham chiếu tới, và cũng không được xoá hai bảng đó vì chúng append-only theo thiết kế.

Đây là chiều im lặng theo đúng nghĩa checklist, và là loại quyết định **phải nằm ở spine**: hai đội sẽ chọn hai cách (một đội xoá cứng, làm hỏng job đối soát `SUM(ledger) == balance` của AD-5; một đội để nguyên, giữ PII vô thời hạn), và cả hai tuân thủ mọi AD hiện có.

**Fix đề xuất:** ít nhất một dòng Deferred có điều kiện quay lại rõ; tốt hơn là một câu Conventions chốt hình mẫu ngay — xoá tài khoản là **xoá danh tính** (`users` bị tẩy PII tại chỗ: ngày sinh, email, tên, ảnh), **không** xoá sổ cái và audit; hai bảng đó chỉ giữ `user_id`, không bao giờ giữ PII. Điều này cũng biến AD-15 thành một luật rộng và nhất quán hơn: *PII sống ở đúng một bảng.*

---

### F-20 · [medium] Seed và Capability Map đã lỗi thời so với chính các AD mới

**Chỗ đứng:** § Structural Seed § Thực thể lõi, § Capability → Architecture Map.

Vòng vá thêm ba bảng mới nhưng không cập nhật hai phần dưới:

- **Sơ đồ thực thể thiếu** `user_balances` (AD-5), `reputation_scores` (AD-8), `room_reservations` (AD-22). Đây không phải chuyện thẩm mỹ: AD-8 vừa thêm Rule *"bảng chủ ghi phải phủ **mọi** bảng trong sơ đồ thực thể"* — nên sơ đồ giờ là một danh sách chuẩn có hiệu lực pháp lý trong spine, và nó đang thiếu ba mục.
- **Capability Map lỗi thời ở ít nhất năm dòng:** US-3.2 vẫn ghi *"`apps/api`"* dù AD-8 vừa giao `reputation_scores` cho `realtime-gateway`; US-2.3 và US-2.4 không nhắc AD-21/AD-22/AD-23 dù ba AD đó được viết ra chính vì chúng; US-1.2 không nhắc AD-22; US-0.5 không nhắc AD-18 dù AD-18 `Binds` US-0.5.

Đây là chỗ over-specification trở thành nợ thật: bảng nào duy trì tay thì bảng đó sẽ lệch, và **tài liệu tự mâu thuẫn tệ hơn tài liệu thiếu** — F-12 và F-20 này đều lộ ra qua đúng bảng đó.

**Fix đề xuất:** cập nhật sơ đồ thực thể (bắt buộc — AD-8 phụ thuộc vào nó) và Capability Map; và cân nhắc sinh Capability Map từ trường `Binds` của các AD thay vì duy trì tay, để nó không lệch lần nữa.

---

### F-21 · [low] AD-16: tiêu đề nói "hai bước", Rule nói "ba nhịp"

Tiêu đề: *"Đóng phòng là **giao thức hai bước**"*. Rule ngay dưới: *"Đóng phòng đi **ba nhịp**: `api` đặt `closing` → `realtime-gateway` chốt sổ, báo lại → `api` mới đóng hẳn."*

Ba nhịp là đúng và là cái phải cài. Tiêu đề là tàn dư từ đề xuất ở `review-adversarial.md` §1. Nhỏ, nhưng tiêu đề AD là thứ được trích trong story và trong code review.

*Fix:* đổi tiêu đề thành "giao thức ba nhịp".

---

### F-22 · [low] Ngân sách hiệu năng của PRD không được neo — và AD-21 vừa làm nó nặng hơn

`docs/prd.md` §1.3 đặt **p90 < 5s** để vào phòng làm *tiêu chí nghiệm thu bắt buộc*, US-1.2 AC2 nói rõ cách đo (từ lúc bấm "Vào phòng" tới lúc nghe tiếng đầu tiên). US-2.1 AC3 đặt **≥ 20 FPS** cho filter.

Spine không nhắc con số nào, không nói ai chịu trách nhiệm. Điều này có ý nghĩa kiến trúc thật, và **tăng lên sau vòng vá**: đường vào phòng giờ là cấp token đồng bộ (AD-9: kiểm ban + tuổi + trần) **cộng một `INSERT` giữ chỗ nguyên tử** (AD-22) rồi mới kết nối LiveKit — và AD-21 thêm một lần kết nối LiveKit thứ hai khi phiên bắt đầu.

*Fix:* một dòng ngắn — đường cấp token của AD-9/AD-22 là **đường nóng**, ngân sách p90 5 giây thuộc về nó, và mọi phép kiểm thêm vào đó phải nằm trong một round-trip DB.

---

### F-23 · [low] Ai sở hữu cấu hình codec / simulcast không được nói

US-1.3 và NFR "Hiệu năng mạng yếu" đòi Opus + DTX/RED và simulcast tự tụt bậc. Capability Map ánh xạ sang *"LiveKit + `apps/web`, governed by AD-2"* — nhưng AD-2 chỉ nói *loại dữ liệu nào* được đi đường media, không nói ai **cấu hình**. Trong LiveKit các tham số này đặt được ở **cả hai** chỗ: room preset phía server (`livekit.yaml`, thuộc infra) và publish options phía client. Đặt hai chỗ, lệch nhau, thì `Thang suy giảm mạng` bốn bậc của `EXPERIENCE.md` — một luồng chính, không phải nhánh lỗi — hành xử khác nhau tuỳ trình duyệt. AD-21 nhân đôi bề mặt này: hai phòng, hai cấu hình publish.

*Fix:* một dòng Conventions — chính sách codec và simulcast sống trong **room preset phía server**, áp cho cả hai loại phòng của AD-21; client không ghi đè, chỉ chọn preset theo tên.

---

### F-24 · [low] Health-check và cách đánh version giao thức WS

- US-0.2 AC3 đòi health-check tường minh. Spine chỉ nhắc "health signal" một lần, **bên trong** một ghi chú của mục Deferred về quan trắc. Với hai process sau một reverse proxy, một đường health thống nhất là convention rẻ mà đáng có.
- AD-13 nói *"mọi payload qua ranh giới process"* khai ở `packages/contracts` và "phá tương thích thì lên `/v2`". Nhưng `/v1` là một **tiền tố URL** — nó không diễn đạt được cho một kết nối WebSocket. Giao thức WS được version thế nào (trường version trong envelope? path `/v1/ws`?) là mơ hồ, và đây đúng là ranh giới mà app phone tương lai sẽ nối vào — tức là chính lý do `/v1` tồn tại.

*Fix:* một dòng Conventions cho cả hai: `GET /healthz` (liveness) + `/readyz` (readiness, gồm DB) trên **cả hai** vỏ; giao thức WS mang cùng số version với REST, khai trong handshake, cùng luật phá-tương-thích ở dòng "Tương thích `/v1`".

---

### F-25 · [low] Hằng số 30 giây tồn tại ở ba nơi mà không được khai là một

`EXPERIENCE.md` dùng 30 giây cho **hai** thứ khác nhau: cửa sổ thử lại khi mất kết nối (bậc 4) và thời gian sống của lời xin tham gia. Spine nhắc con số này trong AD-4 (Rule tạm dừng, trỏ về `EXPERIENCE.md`) và ngụ ý trong AD-23, nhưng không nơi nào khai nó là một hằng số dùng chung.

Cửa sổ thứ nhất là **ranh giới tiền** (quyết định phiên `ended` hay quay lại `active`) và nó phải bằng đúng thời gian client thử lại — hai đơn vị chép tay hai con số là chuyện xảy ra thật. Cửa sổ thứ hai phải tính ở server theo F-08.

*Fix:* khai cả hai trong `packages/contracts` như hằng số có tên, và để client đọc từ đó thay vì hardcode.

---

### F-26 · [low] Over-specification: vài dòng Conventions đọc được từ code tuân thủ

Theo phép thử của `SKILL.md` (*"fix ở đây chỉ khi hai đơn vị chọn lệch được, **và** quyết định không hiển nhiên, **và** là một trade-off thật"*), phần lớn bảng Conventions đạt — `timestamptz`/UTC, coin số nguyên, UUIDv7, envelope lỗi, idempotency, luật tương thích `/v1` đều là trade-off thật.

Hai dòng thì không: *"Naming — thư mục & module: kebab-case cho thư mục"* và *"Naming — bảng DB: snake_case, số nhiều"* — lệch được, nhưng hiển nhiên và không phải trade-off; đọc được từ mười thư mục đầu tiên. Phần **có** giá trị là danh từ miền lấy từ §8 Glossary (`private-session`, không phải `chat-1v1`), và cái đó đã nằm trong dòng module.

*Fix:* gộp hai dòng thành một ("danh từ miền lấy nguyên văn từ §8 Glossary; thư mục kebab-case, bảng snake_case số nhiều"). Nhỏ, nhưng mỗi dòng cắt được là một dòng không thể lỗi thời như F-20.

---

## Những chỗ đã kiểm kỹ và **đạt**

Ghi lại để lần review sau không kiểm lại, và để phần đúng không chìm giữa 26 finding:

- **AD-1 · AD-5 · AD-8 · AD-12 · AD-15 · AD-20 · AD-22** là cưỡng chế máy thật, không phải lời khuyên: lỗi build, `UNIQUE` ở DB, `GRANT` theo role, whitelist logger, cổng CI, `INSERT` có điều kiện. Đây là mẫu mực cho các AD còn lại.
- **AD-8 § Rule (cưỡng chế bằng quyền DB)** là finding hay nhất của vòng vá: *"sở hữu viết trong văn bản là góp ý; sở hữu cưỡng chế bằng `GRANT` là bất biến"* — đúng tinh thần "Rule phải cưỡng chế được" của checklist. (F-04 và F-14 chỉ là hệ quả của việc chưa áp nó **hết**.)
- **AD-5 § Rule (bảng riêng)** — lập luận *"quyền sở hữu tính theo thực thể, Postgres tranh chấp theo hàng"* là loại tri thức đúng chỗ trong spine: không đọc được từ code tuân thủ, và sai thì mất tiền âm thầm.
- **AD-3 § Rule (kéo, không đẩy)** — nhận ra webhook LiveKit là best-effort và không được làm thẩm quyền, rồi nối nó về đúng lập luận đã dùng ở AD-2. Nhất quán và đúng.
- **AD-21** — lập luận "không tách phòng thì `participant_left` mất nghĩa và AD-3 mất tín hiệu liveness" là suy luận thật, không phải sở thích kiến trúc.
- **AD-22** — *"một phép kiểm chỉ đọc là gợi ý, không phải cổng"* là câu đáng trích dẫn trong mọi story có trần. Chỉ tiếc chưa áp cho AD-10 (F-10).
- **AD-19** (không gian khoá phân theo `source`) lường trước cả những nguồn ledger chưa tồn tại — trưởng thành hơn mức thường thấy ở spine MVP.
- **AD-17** khớp chính xác luật *"không có gì trừ coin mà không qua thẻ xác nhận"* của `EXPERIENCE.md`: một ràng buộc mềm từ UX đã hạ cánh đúng chỗ.
- **§ Stack** sau vòng versions là công việc thật: chi tiết TS 7 không có compiler API lập trình được nên `nest build` cần shim TS 6 là thứ chỉ có khi đã kiểm, không phải khi đang nhớ.
- **Độ dài tổng thể vẫn đúng.** 23 AD cho một MVP bốn sprint là nhiều nhưng chưa phình thành solution design. Đây là thứ dễ hỏng nhất và ở đây chưa hỏng.

---

## Thứ tự vá đề xuất

1. **F-01, F-02, F-04** — ba mâu thuẫn nội bộ. Sửa câu chữ, không cần quyết định mới, và phải sửa trước khi bất kỳ story nào trích dẫn AD sai.
2. **F-03** (kênh lệnh) và **F-06** (auth WS) — hai AD mới. Cả hai là điều kiện tiên quyết của story S2/S4; viết sau thì phải sửa lại code.
3. **F-05** (`joined_at`) và **F-10** (trần phiên) — siết hai AD sẵn có; cả hai nằm trên ranh giới tiền.
4. **F-07** (cổng AI), **F-08** (rò rỉ suy ra được), **F-09** (rate limit) — ba chiều còn im lặng, mỗi chiều một AD ngắn. F-07 là gap CASAN H4 mà PRD §10 gọi đích danh là đầu ra của Architecture.
5. **F-20** — cập nhật Seed và Capability Map cho khớp AD-5/8/21/22. Rẻ, và AD-8 đang phụ thuộc vào sơ đồ thực thể để có hiệu lực.
6. Nhóm medium còn lại (F-11 → F-19) — chỉnh AD-11/AD-19, thêm hai dòng Conventions, viết lại ba dòng Deferred.
7. Nhóm low (F-21 → F-26) — gộp vào lần polish cuối.
