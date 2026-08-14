import { supabase } from '../../lib/supabase'

// 라이브 페이지의 실주문 기능용. 세 가지 메서드:
//   POST  - 웹에서 매수/매도 버튼을 누르면 여기로 명령을 만든다. TRADE_PASSWORD(사용자가 직접 정한
//           "MT5 비번" 스타일 별도 비밀번호, /admin 비밀번호와 다름 - 진짜 돈이 걸린 기능이라 노출된
//           라이브 페이지에 아무나 못 누르게 별도로 잠갔다)를 맞혀야 명령이 생성된다.
//   GET   - 두 가지 쓰임:
//           1) ?account_label=X (x-admin-token 필요) - MT5 EA가 자기 계좌의 pending 명령을 가져간다
//              (claim). status를 'pending'에서 'claimed'로 원자적으로 바꾸면서 가져가므로, 여러 번
//              폴링해도 같은 명령이 중복 실행되지 않는다.
//           2) ?id=X (인증 불필요, 자기가 방금 보낸 명령 상태 조회만 가능) - 웹 페이지가 방금 보낸
//              명령이 체결됐는지 폴링해서 보여주는 용도. 상태만 읽고 아무것도 바꾸지 않는다.
//   PATCH - EA가 주문 실행 결과(성공/실패)를 보고한다. x-admin-token 필요.
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { password, account_label, symbol, direction, lot } = req.body || {}
    if (!process.env.TRADE_PASSWORD || password !== process.env.TRADE_PASSWORD) {
      return res.status(401).json({ error: '비밀번호가 틀렸습니다' })
    }
    if (!account_label || !symbol || !['buy', 'sell', 'close'].includes(direction)) {
      return res.status(400).json({ error: '필수 값 누락(account_label, symbol, direction)' })
    }
    const { data, error } = await supabase
      .from('trade_commands')
      .insert({ account_label, symbol, direction, lot: lot ?? null, status: 'pending' })
      .select('id')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, id: data.id })
  }

  if (req.method === 'GET') {
    const { account_label, id } = req.query

    if (id) {
      // 웹 페이지가 자기가 보낸 명령의 체결 상태를 확인하는 용도 - 읽기만 하니 인증 불필요.
      const { data, error } = await supabase
        .from('trade_commands')
        .select('id, status, result_message')
        .eq('id', Number(id))
        .single()
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ command: data })
    }

    const token = req.headers['x-admin-token']
    if (!process.env.ADMIN_SECRET_TOKEN || token !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: '인증 필요' })
    }
    if (!account_label) return res.status(400).json({ error: 'account_label 필요' })

    // pending -> claimed로 바꾸면서 동시에 가져온다(원자적 claim) - 폴링 중복 실행 방지.
    const { data, error } = await supabase
      .from('trade_commands')
      .update({ status: 'claimed', processed_at: new Date().toISOString() })
      .eq('account_label', account_label)
      .eq('status', 'pending')
      .select('id, symbol, direction, lot')
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ commands: data || [] })
  }

  if (req.method === 'PATCH') {
    const token = req.headers['x-admin-token']
    if (!process.env.ADMIN_SECRET_TOKEN || token !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: '인증 필요' })
    }
    const { id, status, result_message } = req.body || {}
    if (!id || !['done', 'error'].includes(status)) {
      return res.status(400).json({ error: '필수 값 누락(id, status)' })
    }
    const { error } = await supabase
      .from('trade_commands')
      .update({ status, result_message: result_message || null, processed_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}
