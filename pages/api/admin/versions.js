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
    // 설치 프로그램(exe)이 수십~수백MB라 Base64로 인코딩해서 이 API로 통째로 보내면
    // Next.js/Vercel의 요청 본문 크기 제한(수 MB 수준)에 바로 걸린다("Request Entity
    // Too Large"). 그래서 실제 파일은 브라우저가 Supabase Storage에 signed URL로
    // 직접 업로드하고, 이 API는 (1) 그 signed URL을 발급해주는 역할과 (2) 업로드가
    //끝난 뒤 DB에 기록만 하는 역할, 두 단계로 나눴다.
    const { action } = req.body

    if (action === 'get-upload-url') {
      const { app, version, fileName } = req.body
      if (!app || !version || !fileName) {
        return res.status(400).json({ error: 'app / version / fileName이 필요합니다' })
      }
      const path = `${app}/${version}-${Date.now()}-${fileName}`
      const { data, error } = await supabase.storage.from('app-updates').createSignedUploadUrl(path)
      if (error) return res.status(500).json({ error: `업로드 URL 생성 실패: ${error.message}` })
      return res.json({ ok: true, path, token: data.token, signedUrl: data.signedUrl })
    }

    const { app, version, changelog, path } = req.body
    if (!app || !version || !path) {
      return res.status(400).json({ error: 'app / version / path가 필요합니다' })
    }

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
