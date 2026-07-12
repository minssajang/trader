-- trader 프로젝트: 라이선스 관리 스키마
-- Supabase SQL Editor에서 그대로 실행하세요.

create extension if not exists pgcrypto;

create table if not exists licenses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  product text not null default 'nt8' check (product in ('nt8', 'mt5')),
  license_key text unique,
  status text not null default 'pending' check (status in ('pending', 'active', 'expired', 'cancelled')),
  requested_months integer,
  start_date date,
  expire_date date,
  note text,
  created_at timestamptz not null default now()
);

alter table licenses enable row level security;
-- anon에게 테이블 직접 SELECT/INSERT/UPDATE 권한은 일부러 하나도 안 준다.
-- 아래 RPC 함수 3개로만 딱 필요한 만큼만 접근하게 한다 (전체 명단 유출 방지).

-- 1) 신청 접수 (랜딩페이지 신청폼에서 호출)
create or replace function apply_license(
  p_name text,
  p_email text,
  p_product text,
  p_months integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  insert into licenses (name, email, product, status, requested_months)
  values (p_name, p_email, p_product, 'pending', p_months)
  returning id into new_id;
  return new_id;
end;
$$;

grant execute on function apply_license(text, text, text, integer) to anon;

-- 2) 본인 라이선스 상태 조회 (내 정보 조회 페이지에서 호출) - 이름+이메일 정확히 일치해야만 조회됨
create or replace function check_license(p_name text, p_email text)
returns table(status text, product text, license_key text, start_date date, expire_date date, requested_months integer)
language sql
security definer
set search_path = public
as $$
  select status, product, license_key, start_date, expire_date, requested_months
  from licenses
  where name = p_name and email = p_email
  order by created_at desc
  limit 1;
$$;

grant execute on function check_license(text, text) to anon;

-- 3) 매매 프로그램에서 라이선스 키 유효성 확인할 때 호출
create or replace function validate_license_key(p_key text)
returns table(valid boolean, status text, product text, expire_date date, days_left integer)
language sql
security definer
set search_path = public
as $$
  select
    (status = 'active' and expire_date >= current_date) as valid,
    status,
    product,
    expire_date,
    (expire_date - current_date)::integer as days_left
  from licenses
  where license_key = p_key
  limit 1;
$$;

grant execute on function validate_license_key(text) to anon;
