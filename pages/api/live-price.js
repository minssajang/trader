import { supabase } from '../../lib/supabase'

// MT5 EA(스크립트)가 2초 간격으로 현재 진행 중인 1분봉을 여기로 올린다(POST). date/time은 브로커
// 서버의 원본 날짜/시각 문자열(EA가 TimeToString으로 만들어 보냄, 예: "2026.08.14" "09:15:00") 그대로
// 저장한다 - 숫자 epoch로 미리 변환해서 보내면 MQL5의 datetime 계산 기준(UTC로 간주)과 히스토리 CSV
// 파싱 쪽 기준(로컬 타임존으로 간주, lib/candleCsv.js toUnixSeconds)이 서로 달라 몇 시간씩 어긋나는
// 문제가 있어서, 원본 문자열을 그대로 넘기고 변환은 항상 toUnixSeconds 한 곳에서만 하기로 했다.
// GET은 라이브 페이지가 폴링하는 용도 - 가격 데이터라 민감하지 않으니 인증 없음(backtest-datasets-public.js와
// 같은 수준). sinceId로 그 이후에 들어온/갱신된 행만 받는다(폴링 커서 - 진행 중인 캔들은 같은 id로
// 계속 upsert되므로, 클라이언트는 매번 sinceId를 마지막으로 받은 id보다 1 작게 요청해서 그 캔들의
// 최신 갱신도 놓치지 않게 한다).
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const token = req.headers['x-admin-token']
    if (!process.env.ADMIN_SECRET_TOKEN || token !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: '인증 필요' })
    }
    const { symbol, date, time, open, high, low, close } = req.body || {}
    if (!symbol || !date || !time || [open, high, low, close].some(v => typeof v !== 'number')) {
      return res.status(400).json({ error: '필수 값 누락(symbol, date, time, open, high, low, close)' })
    }
    const { error } = await supabase
      .from('live_candles')
      .upsert(
        { symbol, bar_date: date, bar_time: time, open, high, low, close, updated_at: new Date().toISOString() },
        { onConflict: 'symbol,bar_date,bar_time' }
      )
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'GET') {
    const { symbol, sinceId } = req.query
    if (!symbol) return res.status(400).json({ error: 'symbol 필요' })
    let query = supabase
      .from('live_candles')
      .select('id, bar_date, bar_time, open, high, low, close')
      .eq('symbol', symbol)
      .order('id', { ascending: true })
    if (sinceId) query = query.gt('id', Number(sinceId))
    const { data, error } = await query.limit(2000)
    if (error) return res.status(500).json({ error: error.message })
    const rows = (data || []).map(r => ({ id: r.id, date: r.bar_date, time: r.bar_time, open: r.open, high: r.high, low: r.low, close: r.close }))
    return res.status(200).json({ rows })
  }

  res.status(405).end()
}
