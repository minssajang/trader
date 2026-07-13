-- trader 프로젝트: 라이선스 키 인증 시 이메일도 함께 일치해야 통과하도록 변경
-- (기존엔 키만 맞으면 통과했음 - 키가 유출/공유돼도 막을 방법이 없었음)
-- Supabase SQL Editor에서 그대로 실행하세요.

drop function if exists validate_license_key(text);

create or replace function validate_license_key(p_key text, p_email text)
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
    and lower(email) = lower(p_email)
  limit 1;
$$;

grant execute on function validate_license_key(text, text) to anon;
