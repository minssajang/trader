-- trader 프로젝트: 쿠팡상품 탭(카테고리) — 쿠팡상품 목록을 탭으로 분류
-- Supabase SQL Editor에서 그대로 실행하세요.

create table if not exists coupang_product_categories (
  id text primary key,
  label text not null,
  created_at timestamptz not null default now()
);
alter table coupang_product_categories enable row level security;

alter table coupang_products add column if not exists category_id text;

insert into coupang_product_categories (id, label) values
  ('book', '책'),
  ('monitor', '모니터'),
  ('monitor-arm', '모니터암'),
  ('food', '먹거리'),
  ('phone', '핸드폰')
on conflict (id) do nothing;
