import { supabase } from '../../../lib/supabase'

function auth(req) {
  const token = req.headers['x-admin-token']
  return token && token === process.env.ADMIN_SECRET_TOKEN
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '80mb' },
  },
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
    const { app, version, changelog, fileBase64, fileName } = req.body
    if (!app || !version || !fileBase64 || !fileName) {
      return res.status(400).json({ error: 'app / version / 파일이 필요합니다' })
    }

    const buffer = Buffer.from(fileBase64, 'base64')
    const path = `${app}/${version}-${Date.now()}-${fileName}`

    const { error: uploadErr } = await supabase.storage
      .from('app-updates')
      .upload(path, buffer, { contentType: 'application/zip', upsert: true })
    if (uploadErr) return res.status(500).json({ error: `업로드 실패: ${uploadErr.message}` })

    const { data: pub } = supabase.storage.from('app-updates').getPublicUrl(path)

    const { data, error } = await supabase
      .from('app_versions')
      .insert({ app, version, download_url: pub.publicUrl, changelog: changelog || '', is_active: true })
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
