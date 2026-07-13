import { supabase } from '../../../lib/supabase'

function auth(req) {
  const token = req.headers['x-admin-token']
  return token && token === process.env.ADMIN_SECRET_TOKEN
}

export default async function handler(req, res) {
  if (!auth(req)) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('app_versions')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ rows: data || [] })
  }

  if (req.method === 'POST') {
    // 설치 프로그램(exe)이 수십~수백MB라 Supabase Storage에 직접 올리려면 무료 플랜
    // 고정 한도(50MB)에 걸린다. 그래서 파일은 GitHub Releases 등에 따로 올려두고,
    // 여기는 그 다운로드 URL만 받아서 DB에 기록한다.
    const { app, version, changelog, download_url } = req.body
    if (!app || !version || !download_url) {
      return res.status(400).json({ error: 'app / version / download_url이 필요합니다' })
    }

    const { data, error } = await supabase
      .from('app_versions')
      .insert({ app, version, download_url, changelog: changelog || '', is_active: true })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true, row: data })
  }

  if (req.method === 'PATCH') {
    const { id, is_active } = req.body
    if (!id) return res.status(400).json({ error: 'id 필수' })
    const { data, error } = await supabase
      .from('app_versions')
      .update({ is_active })
      .eq('id', id)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true, row: data })
  }

  if (req.method === 'DELETE') {
    const { id } = req.body
    if (!id) return res.status(400).json({ error: 'id 필수' })
    const { error } = await supabase.from('app_versions').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
