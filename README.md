# trader

닌자 트레이더 매매 시스템(NT8) / MT5 버전 라이선스 신청·조회·관리 사이트. Next.js 앱으로,
fresh-season 블로그 프로젝트와 동일한 구조(Next.js + Vercel + Supabase, admin 대시보드 +
MCP 서버)를 그대로 가져와 라이선스 관리용으로 축소·개조했습니다.

## 페이지 구성

- `pages/index.js` — 소개 (NT8 / MT5 두 제품 안내)
- `pages/apply.js` — 사용 신청 (이름/이메일/제품/기간 → Supabase RPC로 접수, 입금 계좌 안내)
- `pages/check.js` — 내 정보 조회 (이름+이메일 → 라이선스 상태/남은기간 조회)
- `pages/admin.js` — 관리자 대시보드 (비밀번호 로그인 → 라이선스 목록 확인/발급/연장/취소, 비밀번호 변경)

## 백엔드

Supabase 프로젝트 `trader`를 사용합니다.

- `sql/001_licenses_schema.sql` — `licenses` 테이블 + 공개용 RPC 3개(`apply_license`,
  `check_license`, `validate_license_key`). 테이블 자체는 잠겨있고 이 RPC로만 anon 접근이
  가능해, publishable key가 공개돼도 전체 고객 명단이 유출되지 않습니다.
- `sql/002_settings_and_admin.sql` — 관리자 비밀번호 저장용 `settings` 테이블 +
  MCP `run_sql`/`list_tables` 툴이 쓰는 `run_sql_query` RPC 함수.

두 SQL 파일 다 Supabase SQL Editor에서 순서대로 실행하면 됩니다.

`lib/publicSupabase.js`의 키는 publishable key(공개용)라 저장소에 그대로 커밋해도
안전합니다. **service_role(secret) key는 이 저장소 어디에도 넣지 않습니다** — Vercel
프로젝트 환경변수(`SUPABASE_SERVICE_ROLE_KEY`)로만 등록해 서버사이드(API 라우트, MCP
라우트)에서만 사용합니다.

## 관리자 대시보드

`/admin` 접속 → 비밀번호 로그인. 비밀번호는 `settings` 테이블의 `admin:password_hash`에
sha256으로 저장되며, 미설정 시 환경변수 `NEXT_PUBLIC_ADMIN_PASSWORD`(기본값 `admin1234`)를
사용합니다. 로그인 성공 시 `ADMIN_SECRET_TOKEN`(환경변수)을 받아 `sessionStorage`에 저장,
이후 모든 admin API 호출에 `x-admin-token` 헤더로 실어 보냅니다.

- 라이선스 관리: 신청 목록을 상태별로 확인, "입금 확인 → 키 발급" 클릭 시 라이선스 키
  자동 생성 + 시작일/만료일 계산, 연장/취소/삭제
- 비밀번호 변경

## MCP 서버

`app/api/mcp/route.js` — fresh-season과 동일한 `mcp-handler` 패턴. Claude 커스텀 커넥터로
등록해서 대화 중에 라이선스 신청 확인·발급·연장·취소를 처리할 수 있습니다.

등록 URL: `https://<vercel-deployment>.vercel.app/api/mcp?key=<MCP_SHARED_SECRET>`

제공 툴: `list_licenses`, `issue_license`, `extend_license`, `cancel_license`,
`update_license_note`, 그리고 범용 DB 툴 `list_tables`/`get_rows`/`upsert_row`/`delete_row`/`run_sql`.

## 필요한 Vercel 환경변수

| 이름 | 용도 |
|---|---|
| `SUPABASE_URL` | Supabase 프로젝트 URL (서버사이드) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 키 (서버사이드 전용, 절대 공개 금지) |
| `ADMIN_SECRET_TOKEN` | admin 로그인 성공 시 발급하는 공유 토큰 (직접 임의 문자열로 정함) |
| `MCP_SHARED_SECRET` | MCP 서버 `?key=` 인증용 공유 비밀키 (직접 임의 문자열로 정함) |
| `NEXT_PUBLIC_ADMIN_PASSWORD` | admin 초기 비밀번호 기본값 (설정 안 하면 `admin1234`) |
| `NEXT_PUBLIC_SUPABASE_URL` (선택) | 없으면 `lib/publicSupabase.js`에 하드코딩된 값 사용 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (선택) | 위와 동일 |

## 배포

Vercel에 이 저장소를 Next.js 프로젝트로 연결해서 배포합니다 (Framework Preset: Next.js).

## 라이선스 발급 흐름

1. 신청자가 `/apply`에서 신청 → `licenses` 테이블에 `status='pending'`으로 저장
2. 안내된 계좌로 입금 확인 후, 관리자가 `/admin`(또는 MCP `issue_license` 툴)에서
   "입금 확인 → 키 발급" → `status='active'`, `license_key`, `start_date`, `expire_date` 자동 채움
3. 신청자에게 이메일로 라이선스 키를 안내 (현재는 수동 발송)
4. 신청자가 매매 프로그램에 라이선스 키를 입력하면 활성 여부와 남은 기간이 표시됨
   (`/check`에서도 이름/이메일로 동일하게 셀프 조회 가능)
