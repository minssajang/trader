/**
 * pages/api/admin/system-prompt.js
 * Claude 프로젝트 지침(시스템 프롬프트) 조회 / 저장 (fresh-season 원본 그대로 이식)
 *
 * GET  → 현재 저장된 지침 반환 (인증 불필요 — MCP에서 호출)
 * POST → 지침 덮어쓰기 저장   (admin 인증 필요)
 *
 * id 파라미터로 탭(5종) 구분: claude / main / main2 / month / reference. 없거나 5개가 아니면 'main'.
 */
import { supabase } from '../../../lib/supabase'

const VALID_IDS = ['claude', 'main', 'main2', 'month', 'reference', 'rss_sources']

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

function resolveId(raw) {
  return VALID_IDS.includes(raw) ? raw : 'main'
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const id = resolveId(req.query.id)
    const { data, error } = await supabase.from('system_prompts').select('content, updated_at').eq('id', id).single()
    if (error || !data) return res.status(200).json({ content: '', updated_at: '' })
    return res.status(200).json({ content: data.content, updated_at: data.updated_at })
  }

  if (req.method === 'POST') {
    const isAdmin = req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
    if (!isAdmin) return res.status(401).json({ error: '인증 필요' })

    const { content } = req.body || {}
    const id = resolveId(req.body?.id)
    if (typeof content !== 'string') return res.status(400).json({ error: 'content 필드 필요' })

    const { error } = await supabase.from('system_prompts').upsert({ id, content, updated_at: nowKST() }, { onConflict: 'id' })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}
