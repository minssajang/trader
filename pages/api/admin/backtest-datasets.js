import { supabase } from '../../../lib/supabase'

const BUCKET = 'backtest-data'

function auth(req) {
  const token = req.headers['x-admin-token']
  return token && token === process.env.ADMIN_SECRET_TOKEN
}

export default async function handler(req, res) {
  if (!auth(req)) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('backtest_datasets')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ rows: data || [] })
  }

  if (req.method === 'POST') {
    // 업로드는 브라우저가 Storage에 직접 끝낸 뒤, 그 결과(경로/행수/날짜범위)만 여기 기록한다.
    const { symbol, filename, storage_path, row_count, date_from, date_to } = req.body || {}
    if (!symbol || !filename || !storage_path) {
      return res.status(400).json({ error: 'symbol / filename / storage_path가 필요합니다' })
    }
    const { data, error } = await supabase
      .from('backtest_datasets')
      .insert({ symbol, filename, storage_path, row_count, date_from, date_to })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true, row: data })
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id 필수' })

    const { data: row, error: getErr } = await supabase
      .from('backtest_datasets')
      .select('storage_path')
      .eq('id', id)
      .single()
    if (getErr) return res.status(500).json({ error: getErr.message })

    if (row?.storage_path) {
      await supabase.storage.from(BUCKET).remove([row.storage_path])
    }
    const { error } = await supabase.from('backtest_datasets').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
