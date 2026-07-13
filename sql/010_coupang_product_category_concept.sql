-- trader 프로젝트: 쿠팡상품 탭(카테고리)에 "컨셉" 설명 필드 추가
-- Supabase SQL Editor에서 그대로 실행하세요.

alter table coupang_product_categories add column if not exists concept text default '';
