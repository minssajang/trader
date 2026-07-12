import { supabase } from '../../../lib/supabase'
import { randomUUID } from 'crypto'

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

function auth(req) {
  return req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://trader-beta-liard.vercel.app'

export default async function handler(req, res) {
  const isAdmin = auth(req)

  // 예약 발행 자동 전환
  try {
    const now = nowKST()
    await supabase.from('blog_posts').update({ status: 'published', published_at: now })
      .eq('status', 'scheduled').lte('scheduled_at', now)
  } catch {}

  // 제목 점수·SEO 점수·네이버 요약글·인스타 카드뉴스는 관리자 내부 참고용 —
  // 일반 방문자(비로그인) 응답에는 절대 포함하지 않는다.
  const stripAdminScores = (row) => {
    if (!row) return row
    const { title_score, seo_score, title_score_detail, seo_score_detail, naver_summary, instagram_cards, ...rest } = row
    return rest
  }

  if (req.method === 'GET') {
    const { id, slug, category, limit = 20, offset = 0, q, post_type } = req.query
    if (id) {
      let query = supabase.from('blog_posts').select('*').eq('id', id)
      if (!isAdmin) query = query.eq('status', 'published')
      const { data, error } = await query.single()
      if (error || !data) return res.status(404).json({ error: 'Not found' })
      return res.status(200).json(isAdmin ? data : stripAdminScores(data))
    }
    if (slug) {
      let query = supabase.from('blog_posts').select('*').eq('slug', slug)
      if (!isAdmin) query = query.eq('status', 'published')
      const { data, error } = await query.single()
      if (error || !data) return res.status(404).json({ error: 'Not found' })
      return res.status(200).json(isAdmin ? data : stripAdminScores(data))
    }
    let query = supabase.from('blog_posts').select('*').order('created_at', { ascending: false })
    if (!isAdmin) query = query.eq('status', 'published')
    query = query.eq('post_type', post_type || 'blog')
    if (category) query = query.eq('category', category)
    if (q) {
      const safeQ = String(q).replace(/[(),]/g, ' ').trim()
      if (safeQ) query = query.or(`title.ilike.%${safeQ}%,content.ilike.%${safeQ}%`)
    }
    query = query.range(Number(offset), Number(offset) + Number(limit) - 1)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    const rows = data || []
    return res.status(200).json(isAdmin ? rows : rows.map(stripAdminScores))
  }

  if (!isAdmin) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'POST') {
    const {
      title, slug, content, category, author, status = 'published', scheduled_at,
      summary, tags, cover_image,
      title_score, seo_score, title_score_detail, seo_score_detail, naver_summary, instagram_cards,
    } = req.body
    if (!title || !slug || !content) return res.status(400).json({ error: '필수 항목 누락' })
    const nowIso = nowKST()
    const { data, error } = await supabase.from('blog_posts').insert([{
      id: randomUUID(), title, slug, content, category: category || '',
      summary: summary || '', tags: Array.isArray(tags) ? tags : [], cover_image: cover_image || '',
      author_name: (author && String(author).trim()) || '트레이더 편집팀',
      status, post_type: 'blog',
      scheduled_at: status === 'scheduled' ? (scheduled_at || null) : null,
      published_at: status === 'published' ? nowIso : null,
      title_score: title_score ?? null,
      seo_score: seo_score ?? null,
      title_score_detail: title_score_detail ?? null,
      seo_score_detail: seo_score_detail ?? null,
      naver_summary: naver_summary ?? null,
      instagram_cards: instagram_cards ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    }]).select().single()
    if (error) return res.status(500).json({ error: error.message })

    // Google Indexing API + IndexNow — 발행 즉시 색인 요청 (env 변수 없으면 조용히 스킵)
    const indexStatus = { google: null, indexnow: null }

    if (status === 'published') {
      const pageUrl = `${SITE_URL}/blog/${data.slug}`

      try {
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
          throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 설정되어 있지 않습니다')
        }
        const { GoogleAuth } = require('google-auth-library')
        const auth2 = new GoogleAuth({
          credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
          scopes: ['https://www.googleapis.com/auth/indexing'],
        })
        const client = await auth2.getClient()
        const res2 = await client.request({
          url: 'https://indexing.googleapis.com/v3/urlNotifications:publish',
          method: 'POST',
          data: { url: pageUrl, type: 'URL_UPDATED' },
        })
        indexStatus.google = { ok: true, status: res2.status }
      } catch (e) {
        const detail = e?.response?.data || e?.message || String(e)
        indexStatus.google = { ok: false, error: detail }
      }

      try {
        const INDEXNOW_KEY = process.env.INDEXNOW_KEY
        if (!INDEXNOW_KEY) throw new Error('INDEXNOW_KEY 환경변수가 설정되어 있지 않습니다')
        const r = await fetch('https://api.indexnow.org/indexnow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            host: new URL(SITE_URL).host,
            key: INDEXNOW_KEY,
            keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
            urlList: [pageUrl],
          }),
        })
        indexStatus.indexnow = { ok: r.ok, status: r.status }
      } catch (e) {
        indexStatus.indexnow = { ok: false, error: e.message }
      }
    }

    return res.status(200).json({ ...data, _indexStatus: indexStatus })
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body
    if (!id) return res.status(400).json({ error: 'id 필요' })
    if (updates.status === 'published' && !updates.published_at) updates.published_at = nowKST()
    updates.updated_at = nowKST()
    const { data, error } = await supabase.from('blog_posts').update(updates).eq('id', id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id 필요' })
    const { error } = await supabase.from('blog_posts').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}
