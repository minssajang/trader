import { supabase } from '../../lib/supabase'

// MT5 EA(스크립트)가 여기로 캔들을 올린다(POST, x-admin-token 필요). 두 가지 쓰임이 있다:
//   1) 진행 중인 1분봉 - 2초 간격으로 { symbol, date, time, open, high, low, close } 단건
//   2) 시작 시 1회 과거봉 백필 - { symbol, candles: [{date,time,open,high,low,close}, ...] } 배열
//      (라이브 페이지 지표 워밍업용 - 최근 3일치를 EA가 직접 보낸다)
// date/time은 브로커 서버의 원본 날짜/시각 문자열(EA가 TimeToString으로 만들어 보냄, 예: "2026.08.14"
// "09:15:00") 그대로 저장한다 - 숫자 epoch로 미리 변환해서 보내면 MQL5의 datetime 계산 기준(UTC로 간주)과
// 웹 쪽 히스토리 CSV 파싱 기준(로컬 타임존으로 간주, lib/candleCsv.js toUnixSeconds)이 서로 달라 몇
// 시간씩 어긋나는 문제가 있어서, 원본 문자열을 그대로 넘기고 변환은 toUnixSeconds 한 곳에서만 한다.
// GET은 라이브 페이지가 폴링하는 용도 - 가격 데이터라 민감하지 않으니 인증 없음. 원래 sinceId(auto
// increment 기본키) 기준으로 커서링했는데, EA가 진행 중인 캔들을 500ms마다 같은 행에 계속 upsert해도
// Postgres 시퀀스 자체는 충돌 여부와 무관하게 매 시도마다 소모돼서, id가 "실제 캔들 개수"보다 훨씬
// 빨리 늘어난다(사용자가 직접 API를 수백 번 두드려서 확인 - 최근 구간일수록 id가 텅텅 비어서 새 캔들
// 하나 받는 데 요청이 수십~수백 번 필요했음). 그래서 커서를 sinceDate/sinceTime(캔들의 실제 시각,
// bar_date/bar_time)으로 바꿨다 - 이건 진짜 캔들 개수에 정확히 비례해서 늘어나므로 이 문제가 없다.
// 진행 중인 캔들의 최신 갱신도 놓치지 않기 위해, sinceTime과 "같은" 시각도 포함해서(>=) 요청한다
// (마지막으로 받은 그 캔들을 매번 다시 받아오는 거라 약간 중복이지만, 클라이언트가 id로 merge하니
// 무해함 - 예전 "sinceId를 1 낮춰서 요청"하던 것과 같은 목적).
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const token = req.headers['x-admin-token']
    if (!process.env.ADMIN_SECRET_TOKEN || token !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: '인증 필요' })
    }
    const { symbol } = req.body || {}
    if (!symbol) return res.status(400).json({ error: 'symbol 필요' })

    const rawCandles = Array.isArray(req.body.candles) ? req.body.candles : [req.body]
    if (rawCandles.length === 0) return res.status(400).json({ error: 'candles가 비어있습니다' })

    const rows = []
    for (const c of rawCandles) {
      const { date, time, open, high, low, close } = c || {}
      if (!date || !time || [open, high, low, close].some(v => typeof v !== 'number')) {
        return res.status(400).json({ error: '필수 값 누락(date, time, open, high, low, close)' })
      }
      rows.push({ symbol, bar_date: date, bar_time: time, open, high, low, close, updated_at: new Date().toISOString() })
    }

    const { error } = await supabase
      .from('live_candles')
      .upsert(rows, { onConflict: 'symbol,bar_date,bar_time' })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, count: rows.length })
  }

  if (req.method === 'GET') {
    const { symbol, sinceDate, sinceTime } = req.query
    if (!symbol) return res.status(400).json({ error: 'symbol 필요' })
    let query = supabase
      .from('live_candles')
      .select('id, bar_date, bar_time, open, high, low, close')
      .eq('symbol', symbol)
      .order('bar_date', { ascending: true })
      .order('bar_time', { ascending: true })
    // bar_date="YYYY.MM.DD"/bar_time="HH:MM:SS"는 자릿수가 고정된 텍스트라 사전식(lexicographic)
    // 비교가 시간순 비교와 정확히 일치한다 - date 컬럼과 date+time 조합 두 경우를 or로 묶어서 표현.
    if (sinceDate && sinceTime) {
      query = query.or(`bar_date.gt.${sinceDate},and(bar_date.eq.${sinceDate},bar_time.gte.${sinceTime})`)
    }
    const { data, error } = await query.limit(1000)
    if (error) return res.status(500).json({ error: error.message })
    const rows = (data || []).map(r => ({ id: r.id, date: r.bar_date, time: r.bar_time, open: r.open, high: r.high, low: r.low, close: r.close }))
    return res.status(200).json({ rows })
  }

  res.status(405).end()
}
