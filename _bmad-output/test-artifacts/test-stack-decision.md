---
title: 'Quyết định nền tảng test và CI cho StuWith'
status: 'proposed'
date: '2026-08-21'
author: 'Murat (Master Test Architect) — phiên với IPan'
closes-action-item: 'sprint-status.yaml → epic 1 → "Chốt nền tảng CI + framework test"'
consumed-by: 'Story 1.1 — Dựng khung monorepo, hai process và bốn cổng CI'
governs: 'AD-1, AD-6, AD-20'
---

# Quyết định nền tảng test và CI

## Vì sao có tài liệu này

`/bmad-testarch-framework` **dừng ở preflight**: repo chưa có `package.json`, chưa có cây nguồn — không thể scaffold fixtures vào thư mục chưa tồn tại. Chính Story 1.1 mới là story dựng khung.

Nhưng action item Epic 1 nói đúng: những lựa chọn này phải chốt **trước** khi Story 1.1 sinh commit đầu tiên, vì chúng đóng thẳng vào `package.json`, `tsconfig`, và bốn cổng CI của AD-20. Tài liệu này chốt chúng, không sinh code.

Sau khi Story 1.1 dựng xong khung, chạy lại `/bmad-testarch-framework` để scaffold fixtures và helpers — lúc đó preflight sẽ pass.

## Ràng buộc kế thừa từ spine

| Nguồn | Ràng buộc | Ảnh hưởng lên test stack |
| --- | --- | --- |
| AD-1 | `packages/domain` không import hạ tầng; vi phạm là **lỗi build**, không phải góp ý review | Unit test của domain phải chạy **không cần DB, không cần mạng**. Đây là lý do thật của AD-1, không phải thẩm mỹ |
| AD-6 | Mọi adapter phải qua **một bộ test hợp đồng dùng chung** | Cần một suite export được, chạy lại được trên nhiều adapter — không phải test rời từng adapter |
| AD-20 | Bốn cổng CI: quét credential · kiểm chiều phụ thuộc · test hợp đồng adapter · migration trên bản sao DB có dữ liệu. Deploy VPS cần duyệt thủ công (H5) | Nền tảng CI phải có cơ chế **duyệt thủ công trước deploy** |
| Stack | TypeScript kép: `7.0.2` cho typecheck+web, `@typescript/typescript6@6.0.2` cho `nest build` | Ràng buộc nặng nhất — xem TD-1 và TD-3 |

---

## TD-1 — Unit và integration runner: **Vitest**

**Quyết định:** Vitest cho toàn bộ unit và integration test ở `packages/*` và `apps/api`, `apps/realtime-gateway`. **Không dùng Jest.**

**Lý do — đây không phải chuyện sở thích, mà là chuyện chạy được hay không:**

TypeScript 7.0 ship kèm compiler Go-native và **bỏ compiler API lập trình được** (`Program`/`LanguageService`). API này chỉ quay lại ở **TS 7.1**, vài tháng sau 7.0. `ts-jest` transform bằng cách gọi thẳng vào compiler internals — nó **gãy** dưới TS 7. Đây cũng chính là lý do spine đã phải ghim `@typescript/typescript6` riêng cho `nest build`.

Vitest transform bằng **esbuild** qua Vite, không chạm compiler API nên không dính. Chế độ `vitest --typecheck` gọi `tsc` như một CLI, cũng không dính.

Chọn Jest bây giờ nghĩa là hoặc kéo cả repo về TS 6, hoặc dựng một đường transform thứ ba song song với hai đường TypeScript đã có. Cả hai đều tệ hơn.

**Hệ quả cho Story 1.1:**
- `vitest` là devDependency ở root, cấu hình theo workspace cho từng package
- `packages/domain` chạy với environment `node`, **không có setup file nào chạm DB hoặc mạng** — đây là cách AD-1 được kiểm chứng chứ không chỉ được tuyên bố
- Cấm `ts-jest`, `ts-node`, `ts-morph` và typescript-eslint **type-aware** cho tới khi TS 7.1 ra

---

## TD-2 — E2E: **Playwright**

**Quyết định:** Playwright cho E2E của `apps/web`, và cho cả API test không cần trình duyệt.

**Lý do:** `{detected_stack}` là `fullstack` (Next.js 16.3 + hai process NestJS), và logic chọn của TEA mặc định Playwright cho fullstack. Bốn tiêu chí đều trúng: repo lớn và phức tạp, cần đa trình duyệt, tích hợp API + UI nặng, CI cần song song hoá.

Thêm một lý do riêng của dự án này: Playwright dùng **transpiler babel của chính nó** cho file `.ts`, không phụ thuộc package `typescript` nên không dính vấn đề compiler API của TD-1. Cypress cũng không dính, nhưng không có lợi thế nào bù lại cho một hệ ba process với nhiều luồng realtime.

**Hệ quả cho Story 1.1:** cài `@playwright/test`. Chưa cần viết spec — Story 1.1 chỉ cần lệnh chạy được và một smoke test chạm health-check của cả hai process.

---

## TD-3 — Chính sách TypeScript kép, viết thành luật

**Quyết định:** Ghi rõ trong repo, không để mỗi người tự đoán:

| Việc | Dùng | Ghi chú |
| --- | --- | --- |
| `typecheck` toàn repo, build `apps/web` | `typescript@7.0.2` | Compiler Go-native |
| `nest build` (`apps/api`, `apps/realtime-gateway`) | `@typescript/typescript6@6.0.2` → binary `tsc6` | Cần compiler API cho plugin Swagger |
| Vitest transform | esbuild (Vite) | Không chạm package `typescript` |
| Playwright transform | babel nội bộ | Không chạm package `typescript` |
| Lint | ESLint **không bật type-aware rules** | typescript-eslint chưa chạy được trên TS 7 |

**Cấm cho tới TS 7.1:** `ts-jest`, `ts-morph`, `@typescript-eslint/*` với `parserOptions.project`.

**Hệ quả cho Story 1.1:** AC cuối của story ("cả hai lệnh đều chạy được trong cùng một repo") đã bao đúng việc này — chỉ cần thêm bảng trên vào `AGENTS.md` hoặc `CONTRIBUTING` để người sau không vô tình cài `ts-jest`.

---

## TD-4 — Chiều phụ thuộc AD-1 chặn ở **build**, không phải ở lint

**Quyết định:** Hai lớp, và lớp chính **không phải** ESLint:

1. **Chính — TypeScript project references.** `packages/domain/tsconfig.json` đơn giản **không reference** `apps/*`, `packages/db`, hay bất kỳ package hạ tầng nào. Một lệnh import sai sẽ không resolve được và `tsc` báo lỗi **đúng dòng vi phạm**.
2. **Phụ — `dependency-cruiser` chạy trong CI** như cổng số 2, bắt các đường vòng mà project references bỏ lọt (ví dụ import động, hoặc `import type` bị lạm dụng).

**Lý do:** AC của Story 1.1 viết *"không có cách nào bỏ qua bằng cấu hình cục bộ"*. ESLint **bỏ qua được** bằng một dòng `// eslint-disable-next-line` — nếu chỉ dựa vào ESLint thì AC này sai ngay từ ngày đầu. Lỗi resolve của `tsc` thì không tắt được bằng comment.

**Hệ quả cho Story 1.1:** đây là **cổng CI số 2** của AD-20. Story phải có một test chứng minh cổng hoạt động: thêm một import vi phạm rồi kiểm rằng build đỏ.

---

## TD-5 — Bộ test hợp đồng adapter của AD-6

**Quyết định:** `packages/db` export một **test-kit**: một hàm nhận vào một implementation của port và chạy trọn bộ assertion hợp đồng. Suite này chạy **hai lần** trong CI:

- một lần với adapter **in-memory** (dùng cho unit test của domain)
- một lần với **PostgreSQL 18 thật** dựng bằng Testcontainers

**Lý do:** spine nói thẳng — *"nếu không, một adapter quên điều kiện vẫn tuân thủ đủ mọi AD"*. Cụ thể `debit()` phải khai `InsufficientFunds` là **nhánh trả về bắt buộc xử lý**, không phải exception tuỳ chọn; chỉ một suite chung chạy trên cả hai adapter mới bắt được chuyện một bên quên.

**Lưu ý phạm vi:** đây là hợp đồng **port ↔ adapter**, không phải hợp đồng HTTP. Đừng nhầm với Pact (xem TD-6).

**Hệ quả cho Story 1.1:** đây là **cổng CI số 3**. Story 1.1 chỉ cần dựng khung test-kit chạy được với một port giả — các port thật đến ở Epic 3.

---

## TD-6 — **Hoãn Pact**, dù flag đang bật

**Quyết định:** Không đưa contract testing kiểu Pact vào MVP. `tea_use_pactjs_utils` để nguyên `true` nhưng **chưa ràng buộc** (xem TD-8).

**Lý do:** Pact trả công khi consumer và provider **deploy độc lập**. Ở MVP, `apps/web` và `apps/api` nằm cùng monorepo và lên cùng một VPS — giá trị đó chưa có, trong khi chi phí thì có thật: PactV4 dùng Rust FFI và bắt buộc `fileParallelism: false` + `pool: 'forks'` + `singleFork: true` cùng luật *một `addInteraction()` cho mỗi `it()`*, nếu không sẽ flake trên Linux CI.

Thứ AD-13 thật sự cần — *"thêm trường tuỳ chọn là tương thích; đổi tên, đổi kiểu, bỏ trường, siết ràng buộc là phá vỡ"* — rẻ hơn nhiều khi kiểm bằng chính `packages/contracts`: so schema/OpenAPI sinh ra với bản đã publish của `/v1`.

**Xem lại khi:** `apps/web` tách khỏi lịch deploy của `apps/api`, hoặc có consumer thứ hai (app mobile, đối tác).

---

## TD-7 — Nền tảng CI: **GitHub Actions**

**Quyết định:** GitHub Actions.

**Lý do:** Spine ghi *"chọn nền tảng CI cụ thể là chuyện hoãn được"* — nhưng Story 1.1 phải dựng bốn cổng nên không hoãn thêm được nữa. Yếu tố quyết định là H5: **deploy VPS đòi một bước duyệt thủ công**. GitHub Actions có `environments` với *required reviewers*, đúng cơ chế đó, sẵn có, không cần dựng thêm gì.

⚠️ **Ràng buộc bảo mật bắt buộc** (theo `ci-burn-in.md`): mọi giá trị từ context không tin được (`github.event.*`, `inputs.*`) phải đi qua biến `env:` trung gian, **không bao giờ nội suy thẳng vào khối `run:`**. Đây là đường tiêm script trực tiếp — và cổng số 1 là quét credential, nên để lộ chính token của CI thì mỉa mai quá.

**Nếu IPan muốn khác:** quyết định này là thứ dễ đổi nhất trong tài liệu. Bốn cổng mới là bất biến; công cụ chạy chúng thì không.

---

## TD-8 — Trạng thái hai library mandate của TEA

Theo `library-integration-mandate.md`, một mandate chỉ ràng buộc khi **cả hai cổng** đều đạt: flag `true` **và** package có trong manifest.

| Flag | Trạng thái | Kết luận |
| --- | --- | --- |
| `tea_use_playwright_utils: true` | ❌ Chưa cài (chưa có `package.json`) | **Chưa ràng buộc.** Story 1.1 cài `@seontechnologies/playwright-utils` thì mandate bắt đầu ràng buộc từ đó |
| `tea_use_pactjs_utils: true` | ❌ Chưa cài, và TD-6 hoãn Pact | **Chưa ràng buộc**, cố ý |
| `tea_pact_mcp: mcp` | Không áp dụng (TD-6) | — |

Nói một lần ở đây theo đúng protocol, để lần chạy sau không phải nói lại: hiện tại mọi code test sinh ra sẽ theo **đường vanilla**. Sau khi Story 1.1 cài playwright-utils, chạy lại `/bmad-testarch-framework` để scaffold theo đường mandate (`interceptNetworkCall` thay `page.route`, `apiRequest` thay raw request, `recurse` thay `waitForTimeout`, `mergeTests` để compose fixture).

---

## Bốn cổng AD-20 → công cụ cụ thể

| # | Cổng (AD-20) | Công cụ | Quyết định |
| --- | --- | --- | --- |
| 1 | Quét credential | `gitleaks` chạy trên toàn lịch sử của PR | — |
| 2 | Kiểm chiều phụ thuộc AD-1 | `tsc` project references (chính) + `dependency-cruiser` (phụ) | TD-4 |
| 3 | Test hợp đồng adapter AD-6 | Vitest test-kit × {in-memory, Postgres 18 qua Testcontainers} | TD-5 |
| 4 | Migration trên bản sao DB có dữ liệu | Testcontainers Postgres 18 + dump có seed, chạy migration lên | TD-5 |
| H5 | Duyệt thủ công trước deploy VPS | GitHub Environments + required reviewers | TD-7 |

---

## Về số phiên bản

Các thông tin về **TypeScript 7.0 và ts-jest** trong tài liệu này đã kiểm trên web ngày **21/08/2026** (nguồn ở cuối).

Số phiên bản cụ thể của `vitest`, `@playwright/test`, `dependency-cruiser`, `testcontainers`, `gitleaks` **chưa kiểm** ngày này — tôi cố tình không ghi con số để tránh ghim một phiên bản bịa. **Story 1.1 phải kiểm và ghim từng cái khi cài**, giống cách spine đã kiểm bảng Stack ngày 20/08/2026.

Một điểm cần kiểm lúc cài: Vitest yêu cầu Vite và Node tối thiểu khá cao (tài liệu Vitest nêu Vite ≥ 6.4 và Node ≥ 22.12 ở dòng gần đây) — xác nhận nó khớp với Node mà Next.js 16.3 và NestJS 11.2.1 đang dùng.

---

## Việc còn mở, **không** thuộc quyết định này

Ba action item còn lại trong `sprint-status.yaml` vẫn mở và hoãn được tới đúng epic của chúng:

- SDK face-filter client-side (Story 2.7)
- Nhà cung cấp embedding và **số chiều vector** (Story 4.2) — spine cảnh báo đổi số chiều là migration sinh lại toàn bộ vector
- Cổng thanh toán (Story 5.2)

---

## Nguồn

- [Microsoft Releases TypeScript 7.0 with a Native Go Compiler — InfoQ](https://www.infoq.com/news/2026/08/typescript-7-released/)
- [Announcing TypeScript 7.0 Beta — TypeScript Devblog](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/)
- [Why Your TypeScript 7 Upgrade Broke ESLint, ts-jest, and ts-morph — DEV](https://dev.to/dev_encyclopedia/why-your-typescript-7-upgrade-broke-eslint-ts-jest-and-ts-morph-385k)
- [What Breaks When You Upgrade to TypeScript 7 (tsgo) — Medium](https://medium.com/@krunalkanojiya/what-breaks-when-you-upgrade-to-typescript-7-tsgo-614005afbbd0)
- [NestJS and TypeScript 7 (tsgo): what works, what doesn't](https://fernforge.github.io/devnotes/nestjs-typescript-7/)
- [Vitest — Features](https://vitest.dev/guide/features.html)
- Knowledge fragment nội bộ: `library-integration-mandate.md`, `test-levels-framework.md`, `contract-testing.md`, `ci-burn-in.md`
