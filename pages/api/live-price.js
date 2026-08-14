import { supabase } from '../../lib/supabase'

// MT5 EA(스크립트)가 틱마다(또는 캔들 갱신마다) 현재 캔들을 여기로 올린다(POST). GET은 리플레이
// 라이브 페이지가 주기적으로 폴링해서 새 캔들을 가져가는 용도 - 가격 데이터라 민감하지 않으니 인증 없음
// (backtest-datasets-public.js와 같은 수준). POST는 아무나 값을 흘려넣지 못하게 다른 admin API들과
// 동일한 x-admin-token으로 막는다 - MT5 EA는 WebRequest 헤더에 이 토큰을 실어 보낸다.
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const token = req.headers['x-admin-token']
    if (!process.env.ADMIN_SECRET_TOKEN || token !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: '인증 필요' })
    }
    const { symbol, time, open, high, low, close } = req.body || {}
    if (!symbol || !time || [open, high, low, close].some(v => typeof v !== 'number')) {
      return res.status(400).json({ error: '필수 값 누락(symbol, time, open, high, low, close)' })
    }
    const { error } = await supabase
      .from('live_candles')
      .upsert(
        { symbol, time, open, high, low, close, updated_at: new Date().toISOString() },
        { onConflict: 'symbol,time' }
      )
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'GET') {
    const { symbol, since } = req.query
    if (!symbol) return res.status(400).json({ error: 'symbol 필요' })
    let query = supabase
      .from('live_candles')
      .select('time, open, high, low, close')
      .eq('symbol', symbol)
      .order('time', { ascending: true })
    if (since) query = query.gt('time', Number(since))
    const { data, error } = await query.limit(1000)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ rows: data || [] })
  }

  res.status(405).end()
}
