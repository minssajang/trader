/**
 * /api/tools/keyword-volume
 * 네이버 검색광고 API — 연관 키워드 검색량 + 네이버 블로그 문서수 조회
 *
 * mode=all         : 검색량 + 문서수(null만) 한번에
 * mode=keyword_only: 검색량만 갱신
 * mode=doc_only    : 문서수만 채우기 — 한 번에 chunk개씩 처리 (타임아웃 방지)
 *   ?chunk=50      : 한 번에 처리할 개수 (기본 50, 최대 100)
 *   ?offset=0      : 시작 위치 (프론트가 순차 호출할 때 사용)
 */

import crypto from 'crypto'
import { supabase } from '../../../lib/supabase'

/** 현재 시각을 KST(UTC+9) 기준 ISO 문자열로 반환 */
function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

const NAVER_BASE_URL = 'https://api.naver.com'
const NAVER_URI = '/keywordstool'

// ── 일일 사용량 기록 (doc_batch_log) ────────────────────────────
function todayStr() {
  return nowKST().slice(0, 10)
}
async function addTodayUsed(count) {
  if (!count || count <= 0) return
  try {
    const today = todayStr()
    const { data: existing } = await supabase
      .from('doc_batch_log')
      .select('used')
      .eq('date', today)
      .single()
    const newUsed = (existing?.used || 0) + count
    await supabase
      .from('doc_batch_log')
      .upsert({ date: today, used: newUsed, updated_at: nowKST() }, { onConflict: 'date' })
  } catch (e) {
    console.error('doc_batch_log 기록 오류:', e.message)
  }
}

function makeSignature(timestamp, method, path, secretKey) {
  const message = `${timestamp}.${method}.${path}`
  return crypto.createHmac('sha256', secretKey).update(message).digest('base64')
}

function parseCount(val) {
  if (val === '< 10' || val === '<10') return 5
  return Number(val) || 0
}

// 네이버 블로그 문서수 조회 (개별) — 재시도 1회 포함
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
      await new Promise(r => setTimeout(r, 1200))
      return fetchDocCount(keyword, false)
    }
    if (!res.ok) return null
    const data = await res.json()
    return data.total ?? null
  } catch {
    return null
  }
}

// 배치 처리 — 동시 요청 수 제한(concurrency)으로 Rate limit 방지
async function fetchDocCountBatch(keywords, concurrency = 10) {
  const results = new Array(keywords.length).fill(null)
  let idx = 0

  async function worker() {
    while (idx < keywords.length) {
      const i = idx++
      results[i] = await fetchDocCount(keywords[i])
      await new Promise(r => setTimeout(r, 50))
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, keywords.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET_TOKEN) return res.status(401).json({ error: '인증 필요' })

  const {
    keyword,
    mode = 'all',
    chunk: chunkParam = '50',
    offset: offsetParam = '0',
  } = req.query

  if (!keyword) return res.status(400).json({ error: 'keyword 파라미터가 필요합니다' })

  const chunkSize = Math.min(parseInt(chunkParam, 10) || 50, 100)
  const offset    = parseInt(offsetParam, 10) || 0

  // ── doc_only: 문서수만 chunk 단위로 채우기 ─────────────────────────
  if (mode === 'doc_only') {
    try {
      const { data: nullRows, error: fetchErr } = await supabase
        .from('keyword_stats')
        .select('keyword')
        .eq('hint', keyword)
        .is('doc_count', null)
        .order('keyword')
        .range(offset, offset + chunkSize - 1)

      if (fetchErr) throw new Error(fetchErr.message)

      const { count: totalNull } = await supabase
        .from('keyword_stats')
        .select('*', { count: 'exact', head: true })
        .eq('hint', keyword)
        .is('doc_count', null)

      if (!nullRows || nullRows.length === 0) {
        return res.status(200).json({
          keyword, mode,
          chunk: chunkSize, offset,
          total_null: totalNull || 0,
          filled: 0,
          still_null: totalNull || 0,
          done: true,
          message: '모든 문서수 수집 완료',
        })
      }

      const nullKeywords = nullRows.map(r => r.keyword)
      const counts = await fetchDocCountBatch(nullKeywords, 10)

      const updates = nullKeywords
        .map((kw, i) => ({ keyword: kw, doc_count: counts[i] }))
        .filter(u => u.doc_count != null)

      if (updates.length > 0) {
        await supabase
          .from('keyword_stats')
          .upsert(
            updates.map(u => ({ hint: keyword, keyword: u.keyword, doc_count: u.doc_count })),
            { onConflict: 'hint,keyword', ignoreDuplicates: false }
          )
      }

      const { count: remainNull } = await supabase
        .from('keyword_stats')
        .select('*', { count: 'exact', head: true })
        .eq('hint', keyword)
        .is('doc_count', null)

      const stillNull = remainNull || 0
      const done = stillNull === 0

      await addTodayUsed(nullKeywords.length)

      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json({
        keyword, mode,
        chunk: chunkSize,
        offset,
        processed: nullKeywords.length,
        filled: updates.length,
        failed: nullKeywords.length - updates.length,
        still_null: stillNull,
        done,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── keyword_only / all: 검색광고 API 호출 ─────────────────────────
  const apiKey     = process.env.NAVER_AD_API_KEY
  const secretKey  = process.env.NAVER_AD_SECRET_KEY
  const customerId = process.env.NAVER_AD_CUSTOMER_ID

  if (!apiKey || !secretKey || !customerId) {
    return res.status(500).json({ error: '네이버 검색광고 API 환경변수가 설정되지 않았습니다 (NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID)' })
  }

  const path = NAVER_URI
  const method = 'GET'
  const timestamp = Date.now().toString()
  const signature = makeSignature(timestamp, method, path, secretKey)

  const requestUrl = `${NAVER_BASE_URL}${path}?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`

  try {
    const response = await fetch(requestUrl, {
      method,
      headers: {
        'X-Timestamp': timestamp,
        'X-API-KEY':   apiKey,
        'X-Customer':  String(customerId),
        'X-Signature': signature,
        'Content-Type': 'application/json',
      },
    })

    const rawText = await response.text()
    if (!response.ok) return res.status(response.status).json({ error: `네이버 API 오류: ${rawText}` })

    const data = JSON.parse(rawText)
    const list = data.keywordList || []

    const parsed = list.map(item => {
      const pc     = parseCount(item.monthlyPcQcCnt)
      const mobile = parseCount(item.monthlyMobileQcCnt)
      return {
        hint:        keyword,
        keyword:     item.relKeyword,
        pc,
        mobile,
        total:       pc + mobile,
        competition: item.compIdx || '-',
      }
    }).sort((a, b) => b.total - a.total)

    const keywordList = parsed.map(i => i.keyword)
    const { data: existing } = await supabase
      .from('keyword_stats')
      .select('keyword, doc_count')
      .eq('hint', keyword)
      .in('keyword', keywordList)

    const existingMap = {}
    ;(existing || []).forEach(row => { existingMap[row.keyword] = row.doc_count })

    let docCountMap = {}
    let fetchedCount = 0

    if (mode === 'all') {
      const needsDocCount = parsed.filter(item => existingMap[item.keyword] == null)
      fetchedCount = needsDocCount.length
      if (needsDocCount.length > 0) {
        const counts = await fetchDocCountBatch(needsDocCount.map(i => i.keyword), 10)
        needsDocCount.forEach((item, i) => { docCountMap[item.keyword] = counts[i] })
      }
    }

    const nowIso = nowKST()
    const withDocCount = parsed.map(item => ({
      ...item,
      doc_count: docCountMap[item.keyword] !== undefined
        ? docCountMap[item.keyword]
        : (existingMap[item.keyword] ?? null),
      created_at: nowIso,
    }))

    if (withDocCount.length > 0) {
      const { error: dbError } = await supabase
        .from('keyword_stats')
        .upsert(withDocCount, { onConflict: 'hint,keyword' })
      if (dbError) console.error('Supabase 저장 오류:', dbError.message)
    }

    const results = withDocCount.map(({ hint, ...rest }) => rest)

    if (mode === 'all' && fetchedCount > 0) {
      await addTodayUsed(fetchedCount)
    }

    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({
      keyword,
      mode,
      total_found: list.length,
      saved: withDocCount.length,
      doc_count_fetched: fetchedCount,
      doc_count_skipped: parsed.length - fetchedCount,
      results,
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
