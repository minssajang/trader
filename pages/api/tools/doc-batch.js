/**
 * /api/tools/doc-batch
 * 전체 hint에 걸쳐 doc_count=null인 키워드를 우선순위에 따라 일괄 수집
 *
 * GET  → 현재 상태 조회 (오늘 사용량, hint별 미수집 현황)
 * POST → 한 배치 실행 (최대 chunk개, 일일 한도 내)
 *   body: { chunk?: number, priority?: 'search_volume'|'null_ratio'|'hint_order' }
 *
 * 일일 한도: NAVER_BLOG_DAILY_LIMIT (기본 25000)
 * 오늘 사용량은 Supabase doc_batch_log 테이블에 기록
 */

import { supabase } from '../../../lib/supabase'

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

const DAILY_LIMIT = parseInt(process.env.NAVER_BLOG_DAILY_LIMIT || '25000', 10)
const DEFAULT_CHUNK = 50
const MAX_CHUNK = 200

function todayStr() {
  return nowKST().slice(0, 10)
}

async function getTodayUsed() {
  try {
    const { data } = await supabase
      .from('doc_batch_log')
      .select('used')
      .eq('date', todayStr())
      .single()
    return data?.used || 0
  } catch { return 0 }
}

async function addTodayUsed(count) {
  const today = todayStr()
  try {
    const { data: existing } = await supabase
      .from('doc_batch_log')
      .select('used')
      .eq('date', today)
      .single()

    const newUsed = (existing?.used || 0) + count
    await supabase
      .from('doc_batch_log')
      .upsert({ date: today, used: newUsed, updated_at: nowKST() }, { onConflict: 'date' })
    return newUsed
  } catch (e) {
    console.error('doc_batch_log 업데이트 오류:', e.message)
    return count
  }
}

async function fetchDocCount(keyword, retryOnFail = true) {
  const clientId = process.env.NAVER_CLIENT_ID
  const clientSecret = process.env.NAVER_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  try {
    const res = await fetch(
      `https://openapi.naver.com/v1/search/blog?query=${encodeURIComponent(keyword)}&display=1`,
      {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
        signal: AbortSignal.timeout(8000),
      }
    )
    if ((res.status === 429 || res.status >= 500) && retryOnFail) {
      await new Promise(r => setTimeout(r, 1500))
      return fetchDocCount(keyword, false)
    }
    if (!res.ok) return null
    const data = await res.json()
    return data.total ?? null
  } catch { return null }
}

async function fetchBatch(keywords, concurrency = 8) {
  const results = new Array(keywords.length).fill(null)
  let idx = 0
  async function worker() {
    while (idx < keywords.length) {
      const i = idx++
      results[i] = await fetchDocCount(keywords[i])
      await new Promise(r => setTimeout(r, 60))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, keywords.length) }, () => worker()))
  return results
}

// hint별 미수집 현황 + 우선순위 정렬 — DB의 keyword_doc_null_summary() 함수로 집계한다.
// (예전엔 doc_count=null 행 전체와 전체 행(hint만)을 각각 select()로 통째로 가져와 JS로
//  그룹핑했는데, 둘 다 .limit()이 없어서 Supabase 기본 응답 상한(1,000행)에 걸렸다.
//  sql/010_keyword_doc_null_summary.sql 참고.)
async function getNullSummary(priority = 'search_volume') {
  const { data, error } = await supabase.rpc('keyword_doc_null_summary')
  if (error || !data) return []

  const summary = data.map(r => ({
    hint: r.hint,
    nullCount: r.null_count,
    topTotal: r.top_total,
    totalCount: r.total_count,
    nullRatio: r.null_count / (r.total_count || 1),
  }))

  if (priority === 'null_ratio') {
    summary.sort((a, b) => b.nullRatio - a.nullRatio)
  } else if (priority === 'hint_order') {
    // 그대로 (DB 순서)
  } else {
    summary.sort((a, b) => b.topTotal - a.topTotal)
  }

  return summary
}

export default async function handler(req, res) {
  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET_TOKEN) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'GET') {
    try {
      const todayUsed = await getTodayUsed()
      const remaining = Math.max(0, DAILY_LIMIT - todayUsed)

      const { count: totalNull } = await supabase
        .from('keyword_stats')
        .select('*', { count: 'exact', head: true })
        .is('doc_count', null)

      const summary = await getNullSummary('search_volume')

      return res.status(200).json({
        daily_limit: DAILY_LIMIT,
        today_used: todayUsed,
        remaining,
        total_null: totalNull || 0,
        hints: summary,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  if (req.method === 'POST') {
    const { chunk = DEFAULT_CHUNK, priority = 'search_volume' } = req.body || {}
    const chunkSize = Math.min(parseInt(chunk, 10) || DEFAULT_CHUNK, MAX_CHUNK)

    try {
      const todayUsed = await getTodayUsed()
      const remaining = DAILY_LIMIT - todayUsed

      if (remaining <= 0) {
        return res.status(200).json({
          done: true,
          reason: 'daily_limit',
          today_used: todayUsed,
          daily_limit: DAILY_LIMIT,
          remaining: 0,
          filled: 0,
          total_null: null,
        })
      }

      const actualChunk = Math.min(chunkSize, remaining)

      const { data: nullRows, error } = await supabase
        .from('keyword_stats')
        .select('hint, keyword, total')
        .is('doc_count', null)
        .order('total', { ascending: false })
        .limit(actualChunk)

      if (error) throw new Error(error.message)
      if (!nullRows || nullRows.length === 0) {
        return res.status(200).json({
          done: true,
          reason: 'all_filled',
          today_used: todayUsed,
          remaining,
          filled: 0,
          total_null: 0,
        })
      }

      const keywords = nullRows.map(r => r.keyword)
      const counts   = await fetchBatch(keywords, 8)

      const updates = nullRows
        .map((r, i) => ({ hint: r.hint, keyword: r.keyword, doc_count: counts[i] }))
        .filter(u => u.doc_count != null)

      if (updates.length > 0) {
        await supabase
          .from('keyword_stats')
          .upsert(updates, { onConflict: 'hint,keyword', ignoreDuplicates: false })
      }

      const newUsed = await addTodayUsed(nullRows.length)

      const { count: totalNull } = await supabase
        .from('keyword_stats')
        .select('*', { count: 'exact', head: true })
        .is('doc_count', null)

      const stillNull = totalNull || 0
      const newRemaining = Math.max(0, DAILY_LIMIT - newUsed)

      return res.status(200).json({
        done: stillNull === 0 || newRemaining <= 0,
        reason: stillNull === 0 ? 'all_filled' : newRemaining <= 0 ? 'daily_limit' : 'continue',
        today_used: newUsed,
        daily_limit: DAILY_LIMIT,
        remaining: newRemaining,
        processed: nullRows.length,
        filled: updates.length,
        failed: nullRows.length - updates.length,
        still_null: stillNull,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  return res.status(405).end()
}
