// Supabase 연결 설정 (publishable key는 공개돼도 안전 - RLS로 접근 범위 제한해둠)
const SUPABASE_URL = "https://ztrdgcebsxbhtckstlhn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_uGZpG_7yvdHw_V12dcvXNw_NoEaWHfe";

async function callRpc(fnName, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_PUBLISHABLE_KEY,
      "Authorization": `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`요청 실패 (${res.status}): ${text}`);
  }
  return res.json();
}
