-- trader 프로젝트: 쿠팡 상품 등록 (블로그 등에 수동으로 붙여넣어 쓰는 상품 목록)
-- 광고 관리(AdsensePanel)/쿠팡 관리(CoupangPanel)의 자동 노출 슬롯과는 별개의 등록 전용 목록입니다.
-- Supabase SQL Editor에서 그대로 실행하세요.

create table if not exists coupang_products (
  id text primary key,
  label text default '',
  url text default '',
  banner_html text default '',
  banner_html_blog text default '',
  enabled boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
alter table coupang_products enable row level security;
