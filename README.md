# trader

닌자 트레이더 매매 시스템(NT8) / MT5 버전 라이선스 신청·조회 사이트.

## 페이지 구성

- `index.html` — 소개 (NT8 / MT5 두 제품 안내)
- `apply.html` — 사용 신청 (이름/이메일/제품/기간 → Supabase에 접수, 입금 계좌 안내)
- `check.html` — 내 정보 조회 (이름+이메일 → 라이선스 상태/남은기간 조회)

## 백엔드

Supabase 프로젝트 `trader`를 사용합니다. 스키마는 [`sql/001_licenses_schema.sql`](sql/001_licenses_schema.sql)
참고 (Supabase SQL Editor에서 실행). `licenses` 테이블 자체는 잠겨있고, RPC 함수 3개
(`apply_license`, `check_license`, `validate_license_key`)로만 접근하도록 설계되어
있어 anon 키가 공개돼도 전체 고객 명단이 유출되지 않습니다.

`js/supabase-config.js`의 키는 publishable key(공개용)라 저장소에 그대로 커밋해도
안전합니다. **service_role(secret) key는 이 저장소 어디에도 넣지 않습니다** — 로컬
라이선스 발급/관리용으로만 별도 보관합니다.

## 배포

Vercel에 이 저장소를 연결해서 정적 사이트로 배포합니다 (별도 빌드 설정 불필요).

## 라이선스 발급 흐름

1. 신청자가 `apply.html`에서 신청 → `licenses` 테이블에 `status='pending'`으로 저장
2. 안내된 계좌로 입금 확인 후, 관리자가 Supabase에서 해당 행을 `status='active'`,
   `license_key`, `start_date`, `expire_date`로 채움
3. 신청자가 이메일로 받은 라이선스 키를 매매 프로그램에 입력하면 활성 여부와
   남은 기간이 표시됨 (`check.html`에서도 동일하게 셀프 조회 가능)
