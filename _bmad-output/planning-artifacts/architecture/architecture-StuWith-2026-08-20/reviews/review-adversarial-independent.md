---
name: 'Review đối kháng độc lập — ARCHITECTURE-SPINE StuWith'
target: ../ARCHITECTURE-SPINE.md
reviewer: lens đối kháng độc lập (pass thứ hai)
date: '2026-08-20'
status: findings
scope: 'Tìm chỗ hai đơn vị build tuân thủ ĐỦ 20 AD mà vẫn ráp không khớp'
---

# Review đối kháng độc lập — ARCHITECTURE-SPINE StuWith

> Lượt inline trước đã tìm và vá 5 lỗ (AD-16 đóng phòng, AD-17 giá chụp ảnh, AD-18 thu hồi quyền, AD-8 `room_participants`, AD-19 không gian khoá). Review này **không nhắc lại** chúng. Giá trị của nó là những gì lượt đó bỏ sót.

## Phán quyết

Spine này chắc ở tầng *luật tiền* — AD-4/5/6/7/19 gần như không cạy được — nhưng nó vẫn còn một lớp lỗ hổng khác hẳn loại đã vá: lượt trước vá các **xung đột vòng đời theo thời gian** (ai chết trước ai), còn cái chưa ai đụng tới là các **xung đột về hình dạng và ranh giới vật lý**: một cột tiền nằm trong bảng của chủ khác (`users.balance`), một khái niệm trung tâm chưa từng được ánh xạ xuống hạ tầng (phiên hỏi riêng ↔ phòng LiveKit), một chiều lệnh chưa từng được khai (`realtime-gateway` → `api`), một cửa chặn được giao cho bên **không có quyền ghi** thứ mà nó phải chặn (trần phòng), và ít nhất ba thực thể có thật trong PRD nhưng **không có tên trong bảng chủ ghi của AD-8** (điểm nỗ lực, `audit_events`, hàng chờ "báo tôi khi rảnh"). Nghiêm trọng nhất: mục Deferred "giao diện moderator" **vô hiệu hoá thẳng AD-18** — trong MVP, kênh ban duy nhất là thao tác tay vào DB, mà thao tác tay thì không bao giờ phát lệnh thu hồi. Tôi đếm **4 lỗ critical**, tất cả đều là lỗ mà hai dev/hai agent tuân thủ đủ 20 AD vẫn rơi vào theo hai hướng ngược nhau. Spine chưa nên đóng ở `status: final` cho tới khi ít nhất F1–F4 có AD.

---

## F1 — [critical] Phiên hỏi riêng chưa bao giờ được ánh xạ xuống LiveKit, và chiều lệnh `realtime-gateway` → `api` không tồn tại

**Hai đơn vị**

- **Đơn vị A** — dev/agent làm EPIC S1 (US-1.1/1.2/1.3): dựng phòng học live, cấp token, LiveKit room = phòng học.
- **Đơn vị B** — dev/agent làm EPIC S2 (US-2.3/2.4): dựng phiên hỏi riêng, scheduler coin, luồng xin tham gia.

**Kịch bản dựng**

`EXPERIENCE.md` bắt "kênh hỏi riêng **tách biệt khỏi phòng** — người trong phòng không nghe được" (US-2.3 AC5). Spine không nói câu nào về việc phiên hỏi riêng là **một phòng LiveKit thứ hai** hay là **cùng phòng LiveKit với subscription tách**. Cả hai cách đọc đều tuân thủ trọn vẹn AD-2, AD-3, AD-9, AD-10.

- B đọc AD-9 ("token riêng cho **một lần vào một phòng cụ thể**") và kết luận: phiên hỏi riêng là một LiveKit room riêng, mỗi người vào phiên cần **một token thứ hai**. Nhưng AD-8 nói token là của `api`, còn quyết định chấp nhận lời xin tham gia là của `realtime-gateway` (AD-10). Vậy khi rtg chấp nhận lời xin, nó **phải gọi ngược lên `api`** để xin token. Spine chỉ khai đúng **một** chiều lệnh giữa hai process — `api` → rtg cho nạp coin (AD-8, đoạn ngoại lệ). Chiều rtg → `api` **không tồn tại trong bất kỳ AD nào**. B tự dựng nó (HTTP nội bộ? Redis pub/sub? bảng outbox?).
- A đọc AD-2 ("LiveKit lo signaling + SFU; client nói chuyện trực tiếp với LiveKit") và dựng một token duy nhất cho một phòng, mọi thứ khác là điều khiển track trong cùng room. A không hề dựng đường rtg → `api`.

**Phân kỳ chính xác**

Ráp lại: client của A đã có một `Room` LiveKit đang kết nối và không có chỗ để nhận một token thứ hai giữa phiên (AD-9 cấm tái sử dụng token giữa các phòng, nên không thể "vào thêm"); B thì gửi xuống client một `session_token` mà hợp đồng `/v1` của A không có trường đó. Nặng hơn: **AD-3 sập theo**. AD-3 nói điều kiện "phiên còn tính tiền" suy ra từ tín hiệu server-side của LiveKit về "trạng thái participant và audio track". Nếu phiên hỏi riêng nằm trong cùng room với phòng học, thì webhook `participant_left` chỉ báo *rời phòng học*, không báo *rời phiên hỏi riêng* — B không có tín hiệu nào để dừng đồng hồ, và buộc phải quay về nghe client báo, tức là phá đúng thứ AD-3 tồn tại để chặn. Đây là lỗ tiền, không chỉ lỗ tích hợp.

**Đề xuất — AD-21 (mới)**

> **AD-21 — Phiên hỏi riêng là một phòng LiveKit riêng, và chiều lệnh giữa hai process là hai chiều có khai báo.**
> Mỗi `private_session` ánh xạ 1-1 tới một LiveKit room riêng (`ps_<session_id>`); phòng học và phiên hỏi riêng không bao giờ dùng chung một room. Nhờ vậy webhook participant/track của LiveKit trở thành tín hiệu **không nhập nhằng** cho AD-3.
> Hai chiều lệnh giữa process được khai trong `packages/contracts` như hợp đồng nội bộ có version, không phải lời gọi tuỳ hứng:
> `api → rtg`: `grant_coin` (nạp, thưởng), `revoke_access` (AD-18), `room_closing` (AD-16).
> `rtg → api`: `mint_session_token` (cấp token cho phòng phiên hỏi riêng), `session_closed` (chốt sổ, trả về cho AD-16).
> Mọi lệnh mang khoá idempotent và được ghi audit ở **cả hai đầu**. Thêm một chiều lệnh mới là thêm một mục ở đây, không phải thêm một lời gọi HTTP.

---

## F2 — [critical] `users.balance` là cột tiền nằm trong bảng của chủ khác — AD-8 chia chủ theo *thực thể*, DB thì khoá theo *hàng*

**Hai đơn vị**

- **Đơn vị A** — dev làm US-0.5 + US-3.2/3.3 trong `apps/api`: khai tuổi, hồ sơ, hạng uy tín, huy hiệu. AD-8 giao rõ "Người dùng, hồ sơ, tuổi, xác minh → `api`".
- **Đơn vị B** — dev làm US-2.2/2.3 trong `apps/realtime-gateway`: sổ cái và số dư. AD-8 giao rõ "Sổ cái coin, số dư → `realtime-gateway`".

**Kịch bản dựng**

AD-5 viết bất biến bằng chính tên cột: `SUM(ledger của một user) == users.balance`. Tức spine đã chốt số dư **nằm trong bảng `users`**. Nhưng AD-8 giao cả bảng `users` cho `api`.

A dựng `UserRepository.save(user)` — mẫu chuẩn của mọi ORM (TypeORM/Prisma `update` với object đầy đủ) — và dùng nó cho US-0.5 (ghi ngày sinh), US-3.3 (bật cờ đã xác minh), US-4.1 (đổi gói). A tuân thủ AD-8 tuyệt đối: `users` là của A. A cũng tuân thủ AD-5: A **không có ý định** sửa số dư.

B dựng đúng AD-6: `UPDATE users SET balance = balance − :amt WHERE id = :u AND balance >= :amt`, trong cùng transaction với dòng sổ cái.

**Phân kỳ chính xác**

Trâm đang trong phiên hỏi riêng. 23:14:00 B trừ 120 coin → `balance` 999.880. 23:14:02 A xử lý một request đổi gói: nó đã `SELECT * FROM users` lúc 23:13:58 (khi `balance` còn 1.000.000), rồi ghi lại toàn bộ hàng → `balance` quay về **1.000.000**. Không có exception, không có log lỗi, không AD nào bị vi phạm theo mặt chữ: A không hề "viết `setBalance()`" (AD-5 cấm hàm đó, không cấm ghi cả hàng), A cũng không "đọc-rồi-ghi số dư" theo ý định (AD-6 nói về đường trừ coin). Job đối soát của AD-5 sẽ phát hiện lệch — **sau đó**, và nó không biết phải tin bên nào, vì sổ cái nói 999.880 còn người dùng đã được cấp lại 120 coin miễn phí. Ở chiều ngược lại, cùng cơ chế đó xoá mất một lần nạp 500.000 coin của US-4.2.

Đây là lỗ mà AD-8 **không thể** bắt được, vì AD-8 phát biểu quyền sở hữu ở tầng *thực thể miền*, còn đơn vị tranh chấp thực tế của Postgres là *hàng*.

**Đề xuất — AD-22 (mới), kèm siết AD-5 và AD-8**

> **AD-22 — Số dư là bảng riêng, và chủ ghi được cưỡng chế ở tầng quyền DB.**
> Số dư sống ở bảng riêng `user_balances(user_id PK, balance bigint, updated_at)`, không phải một cột của `users`. Bất biến của AD-5 viết lại thành `SUM(coin_ledger của một user) == user_balances.balance`.
> Quyền sở hữu được cưỡng chế bằng **role DB**, không bằng lời hứa: `api` kết nối bằng role không có `UPDATE` trên `user_balances` và `coin_ledger`; `realtime-gateway` kết nối bằng role không có `UPDATE` trên `users`, `rooms`, `credentials`. Bảng chủ ghi của AD-8 phải ánh xạ 1-1 xuống `GRANT`, và migration cấp quyền là một phần của bộ migration, không phải runbook.
> Hệ quả bắt buộc: **cấm ghi cả hàng** ở mọi repository — mọi `UPDATE` chỉ liệt kê đúng các cột mà lệnh đó có ý định đổi. Đây là cổng thứ năm nên thêm vào AD-20 (lint bắt `save(entity)` toàn hàng trên các bảng có chủ chia sẻ).

---

## F3 — [critical] Deferred "giao diện moderator" vô hiệu hoá AD-18 ngay trong MVP: kênh ban duy nhất là thao tác tay vào DB

**Hai đơn vị**

- **Đơn vị A** — dev làm US-3.4 (xác minh & báo cáo) trong `apps/api`.
- **Đơn vị B** — dev làm bên nhận thu hồi trong `apps/realtime-gateway` theo AD-18.

**Kịch bản dựng**

AD-18 viết: "Ban, hạ gói, hoặc chặn theo tuổi **phải đẩy được** lệnh thu hồi tới `realtime-gateway`". Mặt chữ là *khả năng* ("đẩy được"), không phải *đường đi bắt buộc*. Trong khi đó `docs/prd.md` §7 mục 3 và `EXPERIENCE.md § Open Questions` chốt: MVP **không có giao diện moderator**, "xử lý thủ công qua admin/DB". Spine nhắc lại điều này ở Deferred và trấn an rằng "AD-12 bảo đảm dữ liệu vẫn được ghi để sau này dựng giao diện lên trên".

A đọc đúng như thế: "moderation là thủ công qua DB trong MVP, nên tôi không dựng endpoint ban nào; tôi chỉ dựng luồng **gửi** báo cáo và bảng `reports`". A tuân thủ AD-8 (reports là của `api`), AD-12 (ghi audit), và không vi phạm AD-18 — vì AD-18 chỉ đòi *đẩy được*, và nếu sau này có giao diện thì đường đẩy sẽ có.

B dựng consumer thu hồi rất tử tế: nhận lệnh → cắt phiên → chốt sổ block đang chạy → `RoomServiceClient.removeParticipant()`. B tuân thủ AD-18 hoàn hảo.

**Phân kỳ chính xác**

Consumer của B **không bao giờ nhận được một lệnh nào**. Chủ dự án xử lý một báo cáo quấy rối trong phiên hỏi riêng bằng cách chạy `UPDATE users SET banned_at = now() WHERE id = ...` trên Postgres — đúng như §7 cho phép. Không trigger, không outbox, không webhook: rtg không hề biết. Người bị ban **vẫn ở trong phòng LiveKit, vẫn ở trong phiên hỏi riêng, vẫn tiếp tục nhận coin** cho tới khi tự thoát. Đó là **chính xác** kịch bản mà lượt review trước tạo ra AD-18 để chặn — AD-18 đã được viết, nhưng mục Deferred đã tháo ngòi nó, và không ai vi phạm AD nào.

Đây cũng là lời cảnh báo tự nó nằm trong PRD §6: "gỡ ghi hình + hoãn giao diện moderator = hai lớp phòng vệ cùng mỏng đi một lúc". Spine đang làm nó mỏng thêm lớp thứ ba.

**Đề xuất — siết AD-18 + sửa dòng Deferred**

> **Bổ sung AD-18:** ban/hạ gói/chặn tuổi **không được tồn tại như một trạng thái DB đơn thuần**. Ghi nhận một lệnh cấm phải đi qua đúng **một** đường code trong `apps/api` (`POST /v1/admin/moderation-actions`, bảo vệ bằng role `moderator`), và đường đó có nghĩa vụ: ghi `audit_events` + phát `revoke_access` sang rtg (AD-21) + trả về khi rtg xác nhận đã cắt phiên. Cột `banned_at` là **hệ quả** của lệnh, không phải cách ra lệnh — giống hệt quan hệ giữa `balance` và sổ cái ở AD-5.
> **Deferred sửa lại:** hoãn được là **giao diện** moderator. **Không hoãn được:** endpoint moderation và đường thu hồi. MVP dùng `curl` gọi endpoint đó thay cho một màn hình — nhưng không bao giờ dùng `psql`. Thêm một dòng vào bảng Deferred nói thẳng điều này, vì cách đọc hiện tại đang cho phép đúng thứ AD-18 cấm.

---

## F4 — [critical] Trần phòng: bên kiểm là bên **không có quyền ghi** bảng mình đang kiểm — AD-9 nghe như cưỡng chế được nhưng không giữ nổi chỗ

**Hai đơn vị**

- **Đơn vị A** — dev làm US-1.2 AC3 + US-4.1 AC2 trong `apps/api`: chặn join khi phòng đầy theo trần gói.
- **Đơn vị B** — dev làm hiện diện trong `apps/realtime-gateway`: tiêu thụ webhook LiveKit, ghi `room_participants`.

**Kịch bản dựng**

AD-9 giao cho `api` bốn cửa kiểm, trong đó có "phòng chưa đầy theo trần gói". AD-8 (sau bản vá của lượt trước) giao `room_participants` cho **rtg**, và ghi rõ "`api` **chỉ đọc** khi kiểm trần". A tuân thủ tuyệt đối: `SELECT count(*) FROM room_participants WHERE room_id = ?` → nếu `< cap` thì mint token. A **không thể** chèn một dòng giữ chỗ, vì làm thế là vi phạm AD-8.

B tuân thủ tuyệt đối: chỉ ghi `room_participants` khi webhook `participant_joined` của LiveKit về — đúng lý lẽ mà AD-8 đưa ra ("sự thật về ai đang thật sự trong phòng đến từ webhook LiveKit, không từ ý định vào phòng mà `api` cấp token").

**Phân kỳ chính xác**

Khoảng cách giữa "cấp token" và "webhook về" là **vài giây thật** (pre-join → chọn chế độ khuôn mặt → bấm Vào phòng → ICE/TURN → webhook). Một lớp Campus mở link công khai lúc 20:00: 130 người bấm Vào phòng trong cùng 8 giây. Cả 130 request của A đều đọc `count = 0..12` và **cả 130 đều được cấp token hợp lệ**. Vài giây sau webhook về dồn: B ghi 130 dòng. B không có cửa nào để từ chối — AD-10 chỉ giao cho B cưỡng chế trần **3 người của phiên hỏi riêng**, không giao trần phòng; và từ chối ở tầng webhook thì người dùng đã ở trong phòng LiveKit rồi.

Kết quả: phòng Campus trần 100 chứa 130 người. US-1.2 AC3 và US-4.1 AC2 cùng sai, không AD nào bị vi phạm. Đây đúng nghĩa là "một Rule nghe như cưỡng chế được nhưng có cửa thoát": cửa thoát là **TOCTOU giữa hai chủ**, và AD-8 chính là thứ tạo ra nó khi tách quyền ghi khỏi bên kiểm.

Cùng cơ chế này còn tạo ra một lỗ thứ hai, nhỏ hơn nhưng cùng gốc: người dùng bấm Vào phòng, `api` mint token, rồi người đó **bỏ ở pre-join**. Không webhook nào về. Không ai dọn. Nếu về sau ai đó vá F4 bằng cách cho `api` ghi giữ chỗ mà không có TTL, phòng sẽ "đầy" bằng những người không tồn tại.

**Đề xuất — AD-23 (mới)**

> **AD-23 — Trần phòng cưỡng chế bằng chỗ giữ có hạn, do đúng một chủ cấp.**
> `room_participants` có hai trạng thái: `reserved` (do `api` chèn **nguyên tử** cùng lúc mint token) và `joined` (do rtg nâng cấp khi webhook LiveKit về). Trần được kiểm bằng `count(reserved) + count(joined) < cap` **trong cùng câu lệnh chèn**, dạng `INSERT ... SELECT ... WHERE (SELECT count(*) ...) < :cap` — kiểm và giữ chỗ là một thao tác, không phải hai.
> Chỗ `reserved` có **TTL 90 giây**; hết hạn mà chưa lên `joined` thì tự rụng. Đây là ngoại lệ có kiểm soát thứ hai của AD-8 (song song với ngoại lệ nạp coin) và **phải được ghi thẳng vào bảng của AD-8**: `api` ghi `reserved`, rtg ghi `joined` và xoá, không bên nào chạm trạng thái của bên kia.
> Quy tắc chung rút ra: **một cửa chặn chỉ cưỡng chế được nếu bên kiểm cũng là bên giữ chỗ.** Cửa kiểm chỉ-đọc là gợi ý, không phải cửa chặn.

---

## F5 — [high] `block_index` neo vào `session.started_at`, nhưng người vào sau bắt đầu tính từ lúc họ vào — hai lịch trừ tiền, hai đồng hồ

**Hai đơn vị**

- **Đơn vị A** — dev làm scheduler coin (US-2.3) trong rtg.
- **Đơn vị B** — dev làm `countdown-display` + `card-ask-confirm` (US-2.4 AC8) trong `apps/web`, dựa trên `packages/contracts`.

**Kịch bản dựng**

AD-4 chốt cứng: `block_index = floor((now − session.started_at) / block_size)`, khoá là `(session_id, participant_id, block_index)`. AD-7 chốt: "Block bắt đầu là trừ ngay". US-2.4 AC8 chốt: người vào sau "bắt đầu bị trừ coin **kể từ block đầu tiên sau khi vào**, không truy thu".

Khang xin tham gia và được nhận vào lúc `started_at + 4 phút 12 giây`. Với `block_size = 60s`, block đang chạy của phiên là `block_index = 4`, còn 48 giây.

- A đọc AD-7 ("trừ ngay khi vào một block") + AD-4 (chỉ số neo vào `started_at`) → trừ Khang 120 coin cho `block_index = 4` ngay lúc vào. Khang trả nguyên một block cho 48 giây. Chưa kể một cách đọc khác cũng hợp lệ: `block_index = 4` **đã bị Trâm trả rồi**, nhưng khoá `UNIQUE` có `participant_id` nên dòng của Khang vẫn chèn được — nghĩa là DB không hề chặn cách đọc này.
- B đọc US-2.4 AC8 ("block đầu tiên **sau khi** vào", "không truy thu") → đồng hồ của Khang chỉ bắt đầu ở `block_index = 5`, tức sau 48 giây miễn phí, và `card-ask-confirm` của Khang hiển thị số phút ước tính theo đúng cách hiểu đó.

**Phân kỳ chính xác**

Trên màn hình Khang: đồng hồ nói "còn 8.333 phút" và chưa trừ đồng nào; trong sổ cái: đã trừ 120 coin lúc `T+4:12`. Thẻ giao dịch (`transaction-row`, bắt buộc theo `EXPERIENCE § Luật coin`) hiện một dòng mà giao diện vừa hứa là không có. Đây phá thẳng luật cứng của `EXPERIENCE.md`: "**Không có gì trừ coin mà không qua thẻ xác nhận**" và "không có một đồng coin nào rời ví trong sự bất ngờ".

Nặng hơn ở chỗ nó **không tự lộ**: cả hai đơn vị đều pass test của mình, vì test của A dùng người tham gia vào lúc `T+0` (nơi hai cách đọc trùng nhau) và test của B cũng vậy. Lỗi chỉ nổ ở đúng luồng US-2.4 — luồng mới nhất, ít test nhất, và là luồng có tiền.

Còn một biến thể thứ ba: nếu B tính đồng hồ theo `participant.joined_at` thay vì `session.started_at`, mọi mốc cảnh báo ("còn 2 phút", "còn 1 phút" — mốc phát `aria-live` **đúng một lần** theo `EXPERIENCE § Accessibility Floor`) lệch pha tới 59 giây so với thời điểm trừ thật. Người dùng nghe thông báo "còn 2 phút" rồi bị dừng phiên sau 1 phút 12 giây.

**Đề xuất — siết AD-4 + AD-7**

> **AD-4 bổ sung:** `block_index` là **chỉ số toàn phiên** neo vào `session.started_at` (giữ nguyên, vì nó là thứ làm timer trôi thành độ trễ). Mỗi người tham gia mang thêm `first_billable_block` ghi vào `session_participants` lúc vào phiên, tính bằng `floor((joined_at − session.started_at)/block_size) + 1`. Người tham gia **không bao giờ** bị trừ cho block đang chạy dở lúc họ vào; block đầu tiên họ trả là `first_billable_block`. Phần thời gian lẻ trước đó là quà, có chủ ý, và `card-ask-confirm` của người vào sau nói rõ điều đó.
> **AD-7 bổ sung:** "trừ ở đầu block" nghĩa là ở **ranh giới block của phiên**, không phải ở thời điểm một người vào. Với mọi người tham gia, lần trừ đầu tiên xảy ra ở ranh giới `first_billable_block`.
> **Hợp đồng:** `session.started_at`, `block_size`, `first_billable_block`, `unit_price` (bản chụp của AD-17) đều là trường **bắt buộc** trong payload phiên ở `packages/contracts`. Client không được tự suy ra mốc nào từ đồng hồ máy mình; nó chỉ render những gì server gửi. Đây là ràng buộc cùng loại với AD-3: đồng hồ trên màn hình là ảnh phản chiếu.

---

## F6 — [high] Mất mạng bậc 4: `EXPERIENCE` bắt "tạm dừng rồi thử lại 30 giây", nhưng không AD nào định nghĩa tạm dừng — và AD-4 làm cho khoảng dừng không biểu diễn được

**Hai đơn vị**

- **Đơn vị A** — dev làm scheduler coin + vòng đời phiên trong rtg (US-2.3).
- **Đơn vị B** — dev làm thang suy giảm mạng + reconnect trong `apps/web` (US-1.3, Flow 3).

**Kịch bản dựng**

`EXPERIENCE.md` chốt hai điều rất cụ thể: (1) "Chỉ khi mất hẳn audio (bậc 4) thì phiên **tạm dừng** và chỉ tính đến block cuối đã dùng"; (2) "Tự kết nối lại 30 giây rồi mới đưa về Khám phá". Spine **không có AD nào** về tạm dừng/nối lại một phiên đang tính tiền. AD-3 chỉ nói tín hiệu đến từ đâu, AD-4 nói chỉ số suy ra thế nào.

Trâm mất mạng ở giây thứ 20 của `block_index = 6`, nối lại được ở giây thứ 25 của `block_index = 7`.

- A đọc AD-3 + AD-7 nghiêm túc: LiveKit báo `participant_disconnected` → điều kiện "còn tính tiền" sai → **kết thúc phiên**, chốt sổ đến block 6, phát thẻ tổng kết. Đúng AD-7 ("phiên chỉ tiếp tục sang block kế nếu block đó trừ thành công" — block 7 không trừ được vì không còn participant).
- B dựng đúng `EXPERIENCE`: giữ nguyên UI phiên, banner "Mất kết nối — đang thử lại", đồng hồ đứng, nối lại trong 30 giây thì **quay về đúng phiên cũ**.

**Phân kỳ chính xác**

Trâm nối lại ở giây 25 và thấy phiên vẫn hiện trên màn hình B — nhưng `session_id` đó đã `ended` ở phía A. Mọi thao tác tiếp theo (`Esc` để rời, bấm dừng, nạp coin để tiếp) đều nói chuyện với một phiên đã chết → hoặc lỗi 404 lộ ra giao diện (vi phạm luật "lỗi kỹ thuật không bao giờ lộ ra giao diện"), hoặc B tự tạo phiên mới với `started_at` mới — và lúc đó Minh Anh nhận một `private_session.started` thứ hai mà không ai xác nhận, phá luật "không có gì trừ coin mà không qua thẻ xác nhận".

Ở hướng ngược lại, nếu A chọn giữ phiên sống để chiều B, AD-4 trở thành cái bẫy: `block_index` là hàm của **đồng hồ tường**, nên trong 65 giây mất mạng, block 6 và 7 vẫn "trôi qua". Khi nối lại ở block 7 giây 25, A phải quyết: trừ block 7 (người dùng trả cho 25 giây không có tiếng — phá "chỉ tính đến block cuối đã dùng"), hay bỏ qua tới block 8 (35 giây học miễn phí — phá AD-7). Không có lựa chọn nào đúng, vì khái niệm "phiên tạm dừng" không tồn tại trong mô hình chỉ số của AD-4.

**Đề xuất — AD-24 (mới)**

> **AD-24 — Phiên có trạng thái `suspended`, và thời gian treo không sinh block.**
> Vòng đời phiên hỏi riêng: `active → suspended → active | ended`. rtg chuyển sang `suspended` khi tín hiệu server-side của LiveKit (AD-3) báo mất audio track của một người tham gia; đồng hồ của **riêng người đó** dừng, và block đang chạy dở **không** được trừ lần nữa (nó đã trả rồi theo AD-7).
> `block_index` không còn neo vào đồng hồ tường thuần: mỗi phiên giữ `billable_elapsed_ms` cộng dồn, chỉ tăng khi `active`; `block_index = floor(billable_elapsed_ms / block_size)`. Tính tất định của AD-4 được giữ nguyên (chỉ số vẫn suy ra từ dữ liệu server, vẫn idempotent trên bộ ba khoá), nhưng thời gian treo không còn sinh block ma.
> Cửa sổ `suspended` tối đa **30 giây**, khớp đúng con số `EXPERIENCE` đã hứa với người dùng; quá hạn thì `ended` + thẻ tổng kết. Con số 30 giây này là **một** con số, sống ở `packages/domain`, hai vỏ cùng đọc — không phải hằng số chép hai lần.

---

## F7 — [high] Điểm nỗ lực & hạng uy tín: thực thể **không có tên trong AD-8**, đầu vào thuộc chủ này, đầu ra ghi vào sổ cái của chủ kia

**Hai đơn vị**

- **Đơn vị A** — dev làm EPIC S3 (US-3.2) trong `apps/api`, theo đúng Capability Map ("US-3.2/3.3 Uy tín & huy hiệu → `packages/domain`, `apps/api`").
- **Đơn vị B** — dev sở hữu sổ cái + hiện diện + vòng đời phiên trong rtg.

**Kịch bản dựng**

Bảng chủ ghi của AD-8 có 7 dòng. **Không dòng nào là điểm nỗ lực / hạng uy tín.** Trong khi đó US-3.2 AC1 định nghĩa bốn nguồn điểm, và ba trong bốn nguồn là dữ liệu **của B**:

| Nguồn điểm | Sự thật thuộc về |
|---|---|
| +1/phút có mặt trong phòng có ≥ 2 người (trần 120/ngày) | `room_participants` → **rtg** (AD-8) |
| +20 khi hoàn tất một phiên hỏi riêng ở vai người được hỏi | `private_sessions` → **rtg** (AD-8) |
| +5 khi trả lời được đánh dấu hữu ích trong chat | tin nhắn chat → **rtg** (AD-8) |
| −50 mỗi báo cáo được moderator xác nhận | `reports` → `api` |

Và US-3.2 AC2 đóng vòng ngược lại: "thưởng gem/**coin** hàng tháng theo nỗ lực" — tức A phải làm phát sinh một dòng sổ cái. AD-19 thậm chí đã **hợp thức hoá** nguồn đó bằng tên: `source ∈ {…, reputation_reward, …}`.

**Phân kỳ chính xác**

Ba đường phân kỳ cùng lúc, đều hợp lệ theo mặt chữ:

1. **Ai cộng điểm hiện diện?** A dựng cron trong `api` quét `room_participants` mỗi phút (A chỉ đọc — đúng AD-8). B thấy mình đã có sẵn một scheduler chạy theo nhịp block và tín hiệu presence tươi từ webhook, nên dựng luôn tick +1/phút trong rtg. Cả hai cùng chạy → điểm nhân đôi, và trần 120/ngày chống cày bị vô hiệu hoá vì hai bộ đếm không biết nhau. Ngược lại, nếu mỗi bên đều nghĩ bên kia làm → **không ai** cộng điểm, và US-3.2 im lặng không tồn tại.
2. **Bảng `reputation_scores` là của ai?** Không có trong AD-8, không có trong sơ đồ ER của phần Structural Seed. Hai bên đặt ra hai schema (`points_total + season_id` vs. `events append-only rồi cộng dồn`), và không schema nào sai theo AD nào.
3. **Thưởng coin hàng tháng đi đường nào?** AD-8 chỉ nêu **một** ngoại lệ đã kiểm soát: nạp coin. A đọc AD-19 (`reputation_reward` là một `source` hợp lệ) và kết luận là mình được ghi thẳng sổ cái với `source` đó — nhưng làm thế là phá AD-8 dòng đầu tiên. Nếu A tuân thủ AD-8, A phải phát lệnh sang B — qua một kênh mà **F1 đã chỉ ra là chưa tồn tại**. AD-19 vô tình cấp giấy phép cho một hành vi mà AD-8 cấm: đó là escape hatch thật, không phải cách đọc gượng.

**Đề xuất — bổ sung AD-8 + siết AD-19**

> **Thêm ba dòng vào bảng AD-8:** `reputation_scores` / `reputation_events` → chủ ghi **`realtime-gateway`** (vì 3/4 nguồn điểm là sự thật của rtg, và trần 120/ngày cần một bộ đếm duy nhất cạnh nguồn); `api` chỉ đọc để render hồ sơ, và phát lệnh `reputation.penalty` (−50) khi moderator xác nhận báo cáo, đi qua đúng kênh `api → rtg` của AD-21. `audit_events` → xem F8. Hàng chờ "báo tôi khi rảnh" → xem F12.
> **Siết AD-19:** liệt kê một `source` trong bảng **không** đồng nghĩa với việc cấp quyền ghi cho bên đang cần nó. Thêm một cột `Ai được phát` vào bảng nguồn: `session_tick` → rtg (nội bộ) · `topup` → `api` phát lệnh, rtg ghi · `reputation_reward` → rtg (nội bộ) · `system_grant` → `api` phát lệnh, rtg ghi · `refund` → `api` phát lệnh, rtg ghi. **Chủ ghi sổ cái luôn là rtg, không có ngoại lệ nào khác ngoài những dòng trong bảng này.**

---

## F8 — [high] `audit_events` có hai người ghi và không có hợp đồng hình dạng — AD-8 và AD-12 mâu thuẫn thẳng

**Hai đơn vị**

- **Đơn vị A** — `apps/api`: phải ghi audit cho đăng nhập, báo cáo, hành động moderation, **cấp token phòng** (AD-12 liệt kê đủ bốn).
- **Đơn vị B** — `apps/realtime-gateway`: phải ghi audit cho **mọi thay đổi số dư** (AD-12).

**Kịch bản dựng**

AD-8 tuyên bố "Mỗi thực thể có đúng một chủ ghi" và liệt kê bảy dòng. `audit_events` không có trong đó — nhưng AD-12 giao việc ghi nó cho **cả hai process** một cách không thể tránh: `api` là bên duy nhất biết về login và mint token; rtg là bên duy nhất được ghi sổ cái. Vậy `audit_events` là thực thể **hai chủ ghi**, và spine tự mâu thuẫn ở đúng bảng mà PRD gọi là "bằng chứng khi tranh chấp tiền".

Hai người ghi cùng một bảng append-only thì **không** đụng độ ở tầng ghi — nên lỗi này không lộ ra khi chạy. Nó lộ ra ở **hình dạng**. AD-13 chỉ bắt hợp đồng cho "payload qua ranh giới process"; một dòng DB không phải payload qua ranh giới process, nên A và B không bị AD nào buộc phải thống nhất schema.

**Phân kỳ chính xác**

A ghi `{actor_user_id, action: 'token.minted', room_id, request_id, meta}`. B ghi `{user_id, event_type: 'coin_debited', payload: {session_id, block_index, amount}}`. Cả hai append-only, cả hai không có `UPDATE`/`DELETE`, cả hai tuân thủ AD-12 và AD-15. Nhưng migration của bên chạy sau sẽ hoặc thêm cột song song (bảng có `actor_user_id` **và** `user_id`, một nửa số dòng null mỗi cột), hoặc — tệ hơn — bên thứ hai lặng lẽ dựng bảng thứ hai `audit_log`. Khi có tranh chấp tiền thật, không có **một** truy vấn nào dựng lại được dòng thời gian "Trâm đăng nhập → được cấp token → vào phòng → bắt đầu phiên → bị trừ 6 block → bị ban". Đó chính xác là công dụng duy nhất của AD-12, và nó mất — trong khi cả hai đơn vị đều "tuân thủ AD-12".

Thêm một điểm mờ hạng medium nằm trong cùng lỗ: AD-5 bắt số dư và dòng sổ cái ở **cùng transaction**; AD-12 bắt mọi thay đổi số dư có dòng audit. Dòng audit có nằm trong transaction đó không? Nếu B ghi audit bất đồng bộ (rất tự nhiên, để tick nhanh), một lần crash giữa commit và ghi audit tạo ra một khoản trừ **không có bằng chứng** — đúng thứ MVP không ghi hình không được phép để mất.

**Đề xuất — bổ sung AD-8 + siết AD-12**

> **AD-8 bổ sung một dòng:** `audit_events` là thực thể **chỉ-thêm, nhiều người ghi** — ngoại lệ duy nhất của luật một chủ ghi, và được nêu tên tường minh để nó không bị đọc là một sơ suất. Bù lại, hình dạng của nó bị khoá.
> **AD-12 bổ sung:** schema `audit_events` được khai trong `packages/contracts` (dù nó không đi qua ranh giới process) và hai vỏ dùng **cùng một** hàm ghi từ `packages/db`. Trường bắt buộc: `id` (UUIDv7) · `occurred_at` (timestamptz) · `actor_user_id` (nullable cho hành động hệ thống) · `subject_type` + `subject_id` · `action` (theo quy ước `<danh-từ>.<động-từ quá khứ>` đã có ở Consistency Conventions) · `request_id` · `meta jsonb` đã lọc PII theo AD-15. Danh mục `action` là một union đóng trong `contracts`; thêm một action là một thay đổi hợp đồng, không phải một chuỗi tự do.
> **AD-12 bổ sung (transaction):** dòng audit của một thay đổi số dư nằm **trong cùng transaction** với dòng sổ cái và bản cập nhật số dư. Ba ghi, một commit. Audit bất đồng bộ bị cấm trên đường tiền.

---

## F9 — [high] Xác minh danh tính (KYC) không có nơi cất bằng chứng, và AD-11 cấm đúng thứ nó cần

**Hai đơn vị**

- **Đơn vị A** — dev làm US-3.4 AC1 (KYC nhẹ) trong `apps/api`.
- **Đơn vị B** — dev làm S0 hạ tầng (US-0.2 AC4): `docker-compose` **không có object store**, đúng PRD §5 và giả định A-1.

**Kịch bản dựng**

`EXPERIENCE.md` Flow 4 bước 4 làm KYC thành **cửa chặn bắt buộc**: "Vì đặt giá và nhận coin là hành vi nhạy cảm, hệ thống yêu cầu xác minh danh tính nhẹ **trước khi bật**". Nghĩa là không có KYC thì không ai đặt được giá, không có giá thì US-2.3 không chạy — KYC nằm trên đường tới hạn của cả EPIC S2, không phải một tính năng bên lề.

Nhưng: KYC nhẹ về bản chất là nhận **ảnh giấy tờ** (có khuôn mặt) hoặc **ảnh selfie đối chiếu**. Spine nói ba điều cùng lúc, và ba điều đó không tương thích với nhau:

1. AD-11: "**Không có endpoint nào nhận ảnh khuôn mặt.**" — phát biểu tuyệt đối, không giới hạn vào tính năng ẩn mặt.
2. Stack + `infra/docker-compose.yml` không có object store; PRD US-0.2 AC4 nói "MVP không lưu tệp nhị phân nào của người dùng".
3. Capability Map: "US-3.4 Xác minh & báo cáo → `apps/api`, governed by AD-8, AD-12" — không một chữ nào về nơi cất dữ liệu xác minh.

**Phân kỳ chính xác**

A đến sprint S3, cần dựng KYC, và có ba lối ra — cả ba đều làm hỏng một cam kết kiến trúc mà B đã xây xong:

- A thêm MinIO trở lại `docker-compose` → phá A-1 và kéo theo cả pipeline quét mã độc + retention mà PRD §5 nói "không phải thay đổi nhỏ"; B đã dựng deploy VPS không có volume cho nó.
- A nhét base64 ảnh vào một cột Postgres → không endpoint nào "nhận ảnh khuôn mặt" theo mặt chữ (nó nhận một chuỗi JSON!) — escape hatch trắng trợn của AD-11, và đồng thời làm bảng `users`/`credentials` phình ra thứ mà backup strategy (đang Deferred) chưa hề tính tới.
- A gọi một nhà cung cấp KYC bên thứ ba → một phụ thuộc ngoài mới toanh, không có trong sơ đồ Bối cảnh hệ thống, không có trong Deferred, không có AD nào nói dữ liệu gì được gửi đi và cái gì được lưu lại — trong một sản phẩm bán chính cam kết "khuôn mặt không rời máy bạn".

Bất kể A chọn gì, B đã đóng S0 với một giả định trái ngược. Và lối thứ hai là lối một agent code sẽ chọn tự nhiên nhất, vì nó là lối **không phải sửa file hạ tầng của người khác**.

**Đề xuất — AD-25 (mới) + làm rõ AD-11**

> **AD-25 — Xác minh danh tính không giữ bằng chứng.** MVP xác minh qua **nhà cung cấp bên thứ ba**; hệ thống StuWith chỉ lưu **kết quả** (`verified_at`, `provider`, `provider_reference`, `level`) trong `credentials`, không bao giờ lưu ảnh, số giấy tờ, hay bản sao tài liệu. Không tồn tại endpoint nào của StuWith nhận tệp nhị phân từ người dùng — client nói chuyện trực tiếp với SDK của nhà cung cấp, giống hệt cách client nói chuyện trực tiếp với LiveKit ở AD-2. Chọn nhà cung cấp cụ thể là chuyện hoãn được và phải thêm một dòng vào Deferred; **hình dạng "chỉ lưu kết quả" thì không hoãn được**, vì nó quyết định schema của `credentials` mà S2 đã phụ thuộc vào.
> **AD-11 làm rõ:** phát biểu "không có endpoint nào nhận ảnh khuôn mặt" áp dụng cho **mọi định dạng vận chuyển**, kể cả base64 trong JSON, kể cả data URI. Không có ngoại lệ cho KYC (xem AD-25), cho báo cáo lạm dụng, hay cho ảnh hồ sơ (ảnh hồ sơ là URL từ OAuth provider — PRD US-0.2 AC4).

---

## F10 — [medium] Deferred "chọn cổng thanh toán" đang khoá cứng hình dạng dòng sổ cái `topup` ngay bây giờ

**Hai đơn vị**

- **Đơn vị A** — dev làm S2, người **định nghĩa schema `coin_ledger`** đầu tiên (US-2.2).
- **Đơn vị B** — dev làm S4 (US-4.2), đến sau, cần biên nhận + lịch sử nạp.

**Kịch bản dựng**

Deferred trấn an: "Chọn cổng thanh toán chỉ chạm `apps/api`; AD-8 đã cô lập nó khỏi sổ cái". Điều đó **không đúng theo một chiều**: AD-19 đã đặt `topup` thành một `source` của `coin_ledger`, và US-4.2 AC2 đòi "biên nhận + lịch sử nạp". `EXPERIENCE.md` đóng đinh thêm: "Mọi thay đổi số dư đều sinh một thẻ giao dịch đọc lại được" — tức Ví coin là **một** danh sách, không phải hai tab.

A thiết kế `coin_ledger` cho nhu cầu S2: `(id, user_id, delta, source, idempotency_key, session_id, block_index, created_at)`. Hoàn toàn đủ cho tick.

**Phân kỳ chính xác**

B đến S4 và phát hiện dòng `topup` cần mang: số tiền pháp định + đơn vị tiền tệ, mã tham chiếu của cổng, trạng thái "đang xác nhận" (`EXPERIENCE` Flow 5 bước 5 bắt buộc có **ba** trạng thái quay lại, trong đó "đang xử lý" là trạng thái **chưa có coin**). Nhưng `coin_ledger` là bảng của rtg (AD-8), còn B làm việc trong `api`. B có hai lối, cả hai đều sai:

- B tự thêm cột vào bảng của rtg → vi phạm tinh thần AD-8 và tạo migration mà chủ bảng không biết.
- B dựng bảng `topups` riêng trong `api` → Ví coin phải hợp nhất hai nguồn có hai hình dạng và hai chủ; đối soát của AD-5 (`SUM(ledger) == balance`) vẫn đúng, nhưng "lịch sử giao dịch" của người dùng thì không còn một nguồn.

Vấn đề then chốt: **dòng sổ cái không biểu diễn được trạng thái "đang xử lý"**, vì sổ cái là append-only và một dòng tồn tại nghĩa là tiền đã đổi. `EXPERIENCE` lại bắt phải có một mã tham chiếu hiện ra cho người dùng ở đúng trạng thái đó.

**Đề xuất — siết AD-19 + sửa dòng Deferred**

> **AD-19 bổ sung:** một dòng `coin_ledger` chỉ tồn tại khi tiền **đã** đổi. Ý định thanh toán sống ở bảng riêng `payment_intents` (chủ ghi: `api`) với trạng thái `pending | succeeded | failed`, mang mã tham chiếu hiển thị được cho người dùng. Chỉ khi `succeeded`, `api` phát lệnh `grant_coin` (AD-21) và rtg chèn dòng `topup` mang `idempotency_key = payment_intent.id` — **không** phải id sự kiện của cổng thanh toán, vì cổng có thể phát nhiều sự kiện cho một giao dịch. Hình dạng dòng `topup` (các trường `fiat_amount`, `fiat_currency`, `payment_intent_id`) được chốt **cùng lúc với schema sổ cái ở S2**, không chờ S4.
> **Deferred sửa lại:** hoãn được là **nhà cung cấp** cổng thanh toán. Không hoãn được: hình dạng `payment_intents` + các trường `topup` của sổ cái, vì S2 định nghĩa bảng đó trước S4 và không có `/v2` cho một bảng DB.

---

## F11 — [medium] AD-18 liệt kê **đóng** ba lý do thu hồi, nhưng còn ít nhất ba lý do khác cũng phải cắt phiên đang chạy

**Hai đơn vị**

- **Đơn vị A** — dev làm US-3.4 trong `api`: thu hồi xác minh khi phát hiện KYC gian lận (PRD US-0.5 AC6 cũng dẫn khai gian tuổi về đúng luồng này).
- **Đơn vị B** — dev làm consumer thu hồi trong rtg theo AD-18.

**Kịch bản dựng**

AD-18 viết: "**Ban, hạ gói, hoặc chặn theo tuổi** phải đẩy được lệnh thu hồi". Ba mục, liệt kê đóng. Ba trường hợp sau **không** nằm trong danh sách nhưng có hệ quả y hệt:

1. **Thu hồi xác minh.** `EXPERIENCE` Flow 4 bước 4 làm KYC thành điều kiện *bật* nhận hỏi riêng. Nếu xác minh bị thu hồi giữa một phiên đang chạy, host đó đang nhận coin ở một trạng thái mà hệ thống nói là không được phép.
2. **Người dùng tự khai lại ngày sinh về dưới 18** (PRD US-0.5 AC1 cho phép đổi qua luồng hỗ trợ). Đây *là* "chặn theo tuổi" theo nghĩa rộng, nhưng A hoàn toàn có thể đọc mục đó là "chặn lúc kiểm tuổi ở AD-9" và không phát lệnh gì.
3. **Host tự tắt "nhận hỏi riêng"** giữa phiên. Không phải hình phạt, không nằm trong bất kỳ AD nào — nhưng nó đổi một điều kiện mà tiền đang phụ thuộc vào.

A đọc danh sách đóng và kết luận, hoàn toàn hợp lệ: "trường hợp của tôi không nằm trong AD-18, nên tôi chỉ cập nhật `credentials`". B chờ một lệnh không bao giờ đến.

**Phân kỳ chính xác**

Một host bị thu hồi xác minh vì gian lận bằng cấp vẫn tiếp tục nhận 240 coin/phút từ hai người học cho tới khi tự thoát. Kịch bản này khác kịch bản ban ở chỗ nó **không có ai ra lệnh cấm** — nó chỉ là một cột đổi giá trị — nên nó lọt qua cả AD-18 lẫn bản vá của F3.

Trường hợp (3) còn có một sắc thái nữa: tắt "nhận hỏi riêng" **không nên** cắt phiên đang chạy (người học đã trả tiền cho phút này), nhưng phải chặn người vào sau qua US-2.4. Nếu không nói ra, một đơn vị sẽ cắt và một đơn vị sẽ không.

**Đề xuất — siết AD-18 thành nguyên tắc, bỏ danh sách đóng**

> **AD-18 viết lại phần Rule:** **Mọi** thay đổi ở `api` làm sai đi một điều kiện mà AD-9 đã kiểm lúc cấp token — đã đăng nhập · không bị ban · đủ tuổi cho hành vi · phòng chưa đầy · **và, với vai người được hỏi: đã xác minh và đang bật nhận hỏi riêng** — đều phải phát `revoke_access` sang rtg. Danh sách các điều kiện là **một** danh sách, sống ở `packages/domain`, và AD-9 (cửa cấp) lẫn AD-18 (cửa thu hồi) đọc chung nó. Thêm một điều kiện vào AD-9 mà quên AD-18 phải là lỗi type, không phải sơ suất review.
> Lệnh `revoke_access` mang mức độ: `terminate` (ban, chặn tuổi, thu hồi xác minh — cắt phiên, chốt sổ block đang chạy, đuổi khỏi phòng) hoặc `no_new_entry` (host tắt nhận hỏi riêng, hạ gói — phiên đang chạy sống tới khi tự kết thúc, nhưng mọi lời xin tham gia mới bị từ chối). Mức độ được ghi trong domain cùng danh sách điều kiện, không do mỗi bên tự suy.

---

## F12 — [medium] Hàng chờ "báo tôi khi rảnh" là một thực thể có thật, không có trong ER, không có trong AD-8, và có vòng đời cắt qua ranh giới chủ

**Hai đơn vị**

- **Đơn vị A** — dev làm US-2.4 / trạng thái bận trong rtg.
- **Đơn vị B** — dev làm hiện diện phòng trong rtg **hoặc** dev làm thông báo trong `api` (chính sự mơ hồ này là vấn đề).

**Kịch bản dựng**

`EXPERIENCE.md § Microcopy — busy` đặc tả đầy đủ một cơ chế đăng ký chờ: `busy.cta` "Báo tôi khi rảnh" → `busy.queued.snackbar` → `busy.free.toast` khi người kia rảnh → `busy.left.room` khi người kia rời phòng → `busy.self.after` "Có {n} người muốn hỏi bạn khi nãy". Đây là một thực thể có trạng thái, có TTL, có sự kiện kết thúc. Sơ đồ ER của spine **không có nó**. Bảng AD-8 **không có nó** (dòng gần nhất là "trạng thái bận / xin tham gia" → rtg, nhưng hàng chờ không phải hai thứ đó).

**Phân kỳ chính xác**

- **Nơi lưu:** A đặt trong Redis (ephemeral, khớp "chỉ giữ đăng ký khi người dùng còn ở trong phòng"). B đặt trong Postgres (vì `busy.self.after` phải sống sót qua cả một phiên hỏi riêng dài và phải đếm được `{n}`). Hai nơi, hai TTL, và khi cả hai cùng chạy thì `{n}` của `busy.self.after` không khớp số toast đã phát.
- **Vòng đời cắt qua chủ:** luật "chỉ giữ đăng ký khi người dùng còn ở trong phòng" (`busy.left.room`) buộc hàng chờ phải chết theo `room_participants` — mà `room_participants` chỉ được cập nhật khi webhook LiveKit về (AD-8). Nếu hàng chờ nằm trong Redis với TTL riêng còn presence nằm trong Postgres theo webhook, sẽ có cửa sổ phát toast `busy.free.toast` cho một người **đã rời phòng** — một thông báo về giá của một người đã đi, gửi tới người không còn ở đó.
- **Rò rỉ riêng tư:** `busy.free.toast.body` chứa `{price}`. Nếu B dựng nó ở `api` (nơi có hồ sơ và đơn giá) thay vì rtg (nơi có trạng thái bận), thì `api` phải biết ai đang trong phiên hỏi riêng — mà đó là **thông tin AD-8 giao riêng cho rtg** và `EXPERIENCE` cấm để lộ. Đường đi sai không lộ ra ở test; nó lộ ra ở một endpoint `api` vô tình trả về trạng thái bận.

**Đề xuất — thêm một dòng AD-8 và một dòng ER**

> **AD-8 thêm dòng:** `busy_notify_subscriptions` (hàng chờ "báo tôi khi rảnh") → chủ ghi **`realtime-gateway`**, `api` không đọc. Sống trong Postgres, không phải Redis, vì `busy.self.after` phải đếm lại được sau khi phiên kết thúc; Redis chỉ được dùng làm cache của nó nếu cần. Đăng ký bị huỷ tự động khi dòng `room_participants` tương ứng biến mất — **cùng một chủ ghi, nên huỷ nằm trong cùng transaction**, đúng nguyên tắc chung mà AD-16 đã phát biểu ("thực thể của một chủ không được biến mất khi thực thể sống của chủ kia đang phụ thuộc vào nó").
> **Sơ đồ ER bổ sung:** `users ||--o{ busy_notify_subscriptions`, `rooms ||--o{ busy_notify_subscriptions`, và `reputation_scores` (F7). Sơ đồ Thực thể lõi hiện thiếu ba bảng mà PRD/UX đã đặc tả — một dev đọc sơ đồ đó sẽ tin là mình đã thấy hết.

---

## F13 — [low] `request_id` xuyên hai process là convention không có chủ

Bảng Consistency Conventions bắt "JSON có cấu trúc… có `request_id` xuyên suốt hai process", nhưng không AD nào nói **ai sinh** và **đi bằng header nào**. `apps/web` gọi cả `api` (REST) lẫn `realtime-gateway` (WebSocket) — hai giao thức, hai cách mang metadata. Dev `api` chọn `x-request-id` (chuẩn de-facto của Fastify); dev rtg chọn nhét vào envelope của message WS với tên `traceId`. Khi F8 được vá và `audit_events` có cột `request_id`, hai nửa của cùng một hành trình người dùng vẫn không nối được. Đề xuất: khai `request_id` trong `packages/contracts` như một trường của **envelope dùng chung cho cả REST và WS**, sinh ở `apps/web`, và nếu thiếu thì vỏ sinh bù — cùng một quy tắc cho cả hai vỏ. Chi phí thấp, nhưng nó là điều kiện để AD-12 có ích thay vì chỉ có mặt.

---

## Tóm tắt & thứ tự vá đề xuất

| # | Mức | Lỗ | Vá |
|---|---|---|---|
| F1 | critical | Phiên hỏi riêng ↔ LiveKit chưa ánh xạ; chiều lệnh rtg → `api` không tồn tại | **AD-21** (mới) |
| F2 | critical | `users.balance` — cột tiền trong bảng của chủ khác | **AD-22** (mới) + siết AD-5, AD-8, AD-20 |
| F3 | critical | Deferred moderator UI vô hiệu hoá AD-18 (ban qua `psql`) | Siết **AD-18** + sửa dòng Deferred |
| F4 | critical | Trần phòng: bên kiểm không có quyền giữ chỗ (TOCTOU) | **AD-23** (mới) |
| F5 | high | Người vào sau: `block_index` neo `started_at` vs. "không truy thu" | Siết **AD-4**, **AD-7** + hợp đồng phiên |
| F6 | high | Mất mạng bậc 4: không có khái niệm `suspended`; AD-4 sinh block ma | **AD-24** (mới) |
| F7 | high | Điểm nỗ lực: không chủ, đầu vào của rtg, đầu ra ghi sổ cái của rtg | Bổ sung **AD-8** + siết **AD-19** |
| F8 | high | `audit_events` hai chủ ghi, không hợp đồng hình dạng | Bổ sung **AD-8** + siết **AD-12** |
| F9 | high | KYC không có nơi cất bằng chứng; AD-11 cấm đúng thứ nó cần | **AD-25** (mới) + làm rõ AD-11 |
| F10 | medium | Deferred cổng thanh toán khoá hình dạng dòng `topup` ngay bây giờ | Siết **AD-19** + sửa Deferred |
| F11 | medium | AD-18 liệt kê đóng ba lý do thu hồi; còn ít nhất ba lý do nữa | Viết lại Rule của **AD-18** |
| F12 | medium | Hàng chờ "báo tôi khi rảnh": không chủ, không ER, vòng đời cắt chủ | Bổ sung **AD-8** + sơ đồ ER |
| F13 | low | `request_id` không có chủ và không có hình dạng | Khai trong `packages/contracts` |

**Một mô típ chạy xuyên F2, F4, F7, F8, F12:** AD-8 phát biểu quyền sở hữu ở tầng *thực thể miền*, nhưng thứ thực sự tranh chấp là *hàng DB*, *cột DB*, và *quyền giữ chỗ*. Đề nghị thêm một câu vào chính AD-8, vì nó rẻ hơn năm bản vá rời:

> **Nguyên tắc bổ sung cho AD-8:** bảng chủ ghi phải phủ **mọi** bảng trong sơ đồ ER — một bảng không có tên trong bảng này là một lỗi kiến trúc, không phải một chi tiết chưa quyết. Quyền sở hữu cưỡng chế bằng `GRANT` của Postgres (AD-22), và một cửa kiểm chỉ được gọi là cửa chặn khi bên kiểm cũng là bên giữ chỗ (AD-23).
