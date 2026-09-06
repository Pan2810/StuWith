---
title: '{title}'
type: 'feature' # feature | bugfix | refactor | chore
created: '{date}'
status: 'draft' # draft | ready-for-dev | in-progress | in-review | done
review_loop_iteration: 0 # incremented by step-04 before each review loopback
context: [] # optional: `{project-root}/`-prefixed paths to project-wide standards/docs the implementation agent should load. Keep short — only what isn't already distilled into the spec body.
---

<!-- Target: 900–1300 tokens. Above 1600 = high risk of context rot.
     Never over-specify "how" — use boundaries + examples instead.
     Cohesive cross-layer stories (DB+BE+UI) stay in ONE file.
     IMPORTANT: Remove all HTML comments when filling this template. -->

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

<!-- What is broken or missing, and why it matters. Then the high-level approach — the "what", not the "how". -->

**Problem:** ONE_TO_TWO_SENTENCES

**Approach:** ONE_TO_TWO_SENTENCES

## Boundaries & Constraints

<!-- Three tiers: Always = invariant rules. Ask First = human-gated decisions. Never = out of scope + forbidden approaches. -->

**Always:** INVARIANT_RULES

**Ask First:** DECISIONS_REQUIRING_HUMAN_APPROVAL
<!-- Agent: if any of these trigger during execution, HALT and ask the user before proceeding. -->

**Never:** NON_GOALS_AND_FORBIDDEN_APPROACHES

## I/O & Edge-Case Matrix

<!-- If no meaningful I/O scenarios exist, DELETE THIS ENTIRE SECTION. Do not write "N/A" or "None". -->

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | INPUT | OUTCOME | N/A |
| ERROR_CASE | INPUT | OUTCOME | ERROR_HANDLING |

## Probe ranh giới

<!-- BẮT BUỘC khi story chạm bất kỳ ranh giới nào dưới đây. Nếu KHÔNG chạm ranh giới nào, XOÁ CẢ SECTION. Không viết "N/A", không viết "không có". -->
<!-- Ranh giới tính là: hai process (apps/api <-> apps/realtime-gateway) · hai origin (apps/web <-> apps/api, tức CORS) · một socket (WebSocket, TCP thô) · trình duyệt <-> server · ta <-> nhà cung cấp bên ngoài (LiveKit, provider OAuth, cổng thanh toán). -->
<!-- Vì sao section này tồn tại: Epic 1 có BẢY lần lớp lỗi "test ở hai đầu một seam, không gì chạy khúc giữa", và NĂM trong bảy chỉ bị bắt vì có người tự nghi ngờ rồi dựng probe. Lần thứ bảy sống trên sản phẩm qua cả bảy story, trốn được ba suite xanh, và chỉ chết khi có người mở trình duyệt thật hỏi "header này có tới nơi không". Việc đo không được là thói quen của ai đó — nó phải là một ô phải điền. -->
<!-- Điền TRƯỚC khi viết mã, không phải sau. Một probe nghĩ ra ở vòng review là một probe được thiết kế để đồng ý với mã đã viết. -->

**Ranh giới:** WHICH_BOUNDARY_AND_WHY

**Probe:** WHAT_RUNS_IN_THE_REAL_MEDIUM
<!-- Phải chạy ở ĐÚNG tầng của ranh giới. Trình duyệt thật cho CORS/DOM (Playwright `page.evaluate`), socket thô cho giao thức (`node:net`), process thật cho seam hai process. Một hàm gọi một hàm KHÔNG phải probe: `fetch` của Node bỏ qua CORS hoàn toàn, và đó chính là lý do 68 ca flow test của Epic 1 xanh trong lúc trình duyệt nhận `null`. -->

**Sẽ đỏ khi:** THE_MUTATION_THAT_MUST_KILL_IT
<!-- Nêu đúng một thay đổi ở PHÍA BÊN KIA của seam làm probe đỏ, và chạy nó. Probe không mutation-test được là một assertion chưa biết mình canh gì. -->

</frozen-after-approval>

## Code Map

<!-- Agent-populated during planning. Annotated paths prevent blind codebase searching. -->

- `FILE` -- ROLE_OR_RELEVANCE
- `FILE` -- ROLE_OR_RELEVANCE

## Tasks & Acceptance

<!-- Tasks: backtick-quoted file path -- action -- rationale. Prefer one task per file; group tightly-coupled changes when splitting would be artificial. -->
<!-- If an I/O Matrix is present, include a task to unit-test its edge cases. -->
<!-- AC covers system-level behaviors not captured by the I/O Matrix. Do not duplicate I/O scenarios here. -->

**Execution:**
- [ ] `FILE` -- ACTION -- RATIONALE

**Acceptance Criteria:**
- Given PRECONDITION, when ACTION, then EXPECTED_RESULT

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Do not modify or delete existing entries.
     Each entry records: what finding triggered the change, what was amended, what known-bad state
     the amendment avoids, and any KEEP instructions (what worked well and must survive re-derivation).
     Empty until the first bad_spec loopback. -->

## Design Notes

<!-- If the approach is straightforward, DELETE THIS ENTIRE SECTION. Do not write "N/A" or "None". -->
<!-- Design rationale and golden examples only when non-obvious. Keep examples to 5–10 lines. -->

DESIGN_RATIONALE_AND_EXAMPLES

## Verification

<!-- If no build, test, or lint commands apply, DELETE THIS ENTIRE SECTION. Do not write "N/A" or "None". -->
<!-- How the agent confirms its own work. Prefer CLI commands. When no CLI check applies, state what to inspect manually. -->

**Commands:**
- `COMMAND` -- expected: SUCCESS_CRITERIA

**Manual checks (if no CLI):**
- WHAT_TO_INSPECT_AND_EXPECTED_STATE
