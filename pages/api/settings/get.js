import { supabase } from '../../../lib/supabase'

const DEFAULT_AD_SLOTS = [
  { id: 'home_top',    name: '홈 페이지 상단 배너',       active: false, code: '', source: 'adsense' },
  { id: 'blog_top',    name: '블로그 목록 상단 배너',     active: false, code: '', source: 'adsense' },
  { id: 'blog_middle', name: '블로그 글 본문 중간 배너',  active: false, code: '', source: 'adsense' },
  { id: 'board_top',   name: '자유게시판 목록 상단 배너', active: false, code: '', source: 'adsense' },
  { id: 'footer',      name: '전체 페이지 하단 푸터 배너', active: false, code: '', source: 'adsense' },
  { id: 'home_left',   name: '홈 페이지 좌측 사이드',     active: false, code: '', source: 'adsense' },
  { id: 'home_right',  name: '홈 페이지 우측 사이드',     active: false, code: '', source: 'adsense' },
  { id: 'download_interstitial', name: '다운로드 전면 광고(카운트다운)', active: false, code: '', source: 'adsense' },
]

const DEFAULTS = { adSlots: DEFAULT_AD_SLOTS, adsOn: true }

function normalizeAdSlots(raw) {
  if (!raw) return DEFAULT_AD_SLOTS
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return DEFAULT_AD_SLOTS
}

function normalizeBool(raw, fallback) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') return raw === 'true'
  return fallback
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  try {
    const { data, error } = await supabase.from('settings').select('key, value')
      .in('key', ['site:ad_slots', 'site:ads_on'])
    if (error) throw error
    const map = {}
    for (const row of data || []) map[row.key] = row.value
    return res.status(200).json({
      adSlots: normalizeAdSlots(map['site:ad_slots']),
      adsOn: normalizeBool(map['site:ads_on'], DEFAULTS.adsOn),
    })
  } catch {
    return res.status(200).json(DEFAULTS)
  }
}
