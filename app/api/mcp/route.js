// app/api/mcp/route.js
//
// 매매 시스템(trader) 라이선스 관리용 MCP(Model Context Protocol) 서버.
// Vercel 공식 mcp-handler 패키지로 Streamable HTTP 프로토콜을 구현한다.
// Claude(연결된 커넥터)가 이 툴들을 직접 호출해서 라이선스 신청 확인·발급·연장·취소를
// 대화 중에 처리할 수 있게 하는 것이 목적이다. (fresh-season의 app/api/mcp/route.js
// 패턴을 그대로 가져와 trader용으로 축소·개조함)
//
// 환경변수 (Vercel 프로젝트 설정에 등록):
//   SUPABASE_URL                - trader Supabase 프로젝트 URL
//   SUPABASE_SERVICE_ROLE_KEY   - service_role(secret) 키. 절대 커밋 금지, 여기서만 서버사이드로 사용
//   MCP_SHARED_SECRET           - 이 MCP 서버 보호용 공유 비밀키 (직접 정해서 등록)
//   GITHUB_TOKEN (선택)          - list_github_files/get_github_file 툴의 GitHub API 요청 한도를
//                                  늘리고 싶을 때만 등록. 없어도 동작(공개 저장소, 시간당 60회 제한)
//   NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID (선택)
//                                - naver_keyword_volume 툴의 네이버 검색광고 키워드도구 API
//   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (선택)
//                                - naver_keyword_volume이 네이버 블로그 문서수(docCount)도 함께 반환하게 함
//   GOOGLE_SERVICE_ACCOUNT_JSON / INDEXNOW_KEY (선택)
//                                - 블로그 발행 시 Google Indexing API / IndexNow 자동 색인 요청
//
// claude.ai 커스텀 커넥터 등록 URL:
//   https://<vercel-deployment>.vercel.app/api/mcp?key=여기에_MCP_SHARED_SECRET_값
//
// run_sql / list_tables 툴이 쓰는 run_sql_query RPC 함수는 sql/002_settings_and_admin.sql에 정의돼 있다.
// (Supabase SQL Editor에서 최초 1회 실행 필요)
// 키워드 리서치·발행기록 툴(naver_keyword_volume/search_keyword_data/pick_keyword/
// search_keyword_picks/mark_keyword_used/add_publish_log/get_publish_log)이 쓰는
// keyword_stats/keyword_picks/publish_log 테이블은 sql/005_keyword_tools.sql에 정의돼 있다.

import { createMcpHandler } from 'mcp-handler'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import crypto from 'crypto'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://trader-beta-liard.vercel.app'

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

function fmt(n) { return (n || 0).toLocaleString('ko-KR') }

// ── 네이버 검색광고 키워드도구 (fresh-season과 동일 로직) ──────────────────
const NAVER_BASE_URL = 'https://api.naver.com'
const NAVER_URI = '/keywordstool'

function buildNaverHeaders() {
  const apiKey = process.env.NAVER_AD_API_KEY
  const secretKey = process.env.NAVER_AD_SECRET_KEY
  const customerId = process.env.NAVER_AD_CUSTOMER_ID
  if (!apiKey || !secretKey || !customerId) {
    throw new Error('네이버 검색광고 API 환경변수가 설정되지 않았습니다 (NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID)')
  }
  const timestamp = Date.now().toString()
  const message = `${timestamp}.GET.${NAVER_URI}`
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('base64')
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Timestamp': timestamp,
    'X-API-KEY': apiKey,
    'X-Customer': String(customerId),
    'X-Signature': signature,
  }
}

function normalizeKeywords(raw) {
  return String(raw || '').split(',').map(k => k.trim().replace(/\s+/g, '')).filter(Boolean).slice(0, 5)
}

async function fetchNaverKeywordData(keywords) {
  const headers = buildNaverHeaders()
  const hintKeywords = keywords.join(',')
  const url = `${NAVER_BASE_URL}${NAVER_URI}?hintKeywords=${encodeURIComponent(hintKeywords)}&showDetail=1`
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(8000) })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`네이버 API 오류 (${response.status}): ${text}`)
  }
  const data = await response.json()
  const list = Array.isArray(data?.keywordList) ? data.keywordList : []
  const parsed = list.map(item => {
    const pc = item.monthlyPcQcCnt === '< 10' ? 5 : Number(item.monthlyPcQcCnt) || 0
    const mobile = item.monthlyMobileQcCnt === '< 10' ? 5 : Number(item.monthlyMobileQcCnt) || 0
    return {
      keyword: item.relKeyword,
      monthlySearchPc: pc,
      monthlySearchMobile: mobile,
      monthlySearchTotal: pc + mobile,
      competition: item.compIdx,
    }
  }).sort((a, b) => b.monthlySearchTotal - a.monthlySearchTotal)

  const clientId = process.env.NAVER_CLIENT_ID
  const clientSecret = process.env.NAVER_CLIENT_SECRET
  if (clientId && clientSecret) {
    const docCounts = await Promise.all(
      parsed.map(async (item) => {
        try {
          const res = await fetch(
            `https://openapi.naver.com/v1/search/blog?query=${encodeURIComponent(item.keyword)}&display=1`,
            { headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }, signal: AbortSignal.timeout(5000) }
          )
          if (!res.ok) return null
          const d = await res.json()
          return d.total ?? null
        } catch { return null }
      })
    )
    return parsed.map((item, i) => ({ ...item, docCount: docCounts[i] }))
  }
  return parsed
}

function addMonths(dateStr, months) {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

function addDays(dateStr, days) {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// requested_months === 0 은 "무료체험(7일)"을 의미한다
function computeExpireDate(startDate, months) {
  return months === 0 ? addDays(startDate, 7) : addMonths(startDate, months)
}

function genLicenseKey() {
  return randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase().replace(/(.{5})/g, '$1-').replace(/-$/, '')
}

// 신청 → 입금확인 → 라이선스 발행 → 메일발송, 4단계 파이프라인 (admin 화면과 동일한 규칙)
function getStage(r) {
  if (r.status === 'expired' || r.status === 'cancelled') return 'closed'
  if (r.status === 'active') return r.email_sent_at ? 'done' : 'issued'
  return r.deposit_confirmed_at ? 'deposit' : 'applied'
}

const STAGE_LABEL = { applied: '① 신청', deposit: '② 입금확인', issued: '③ 라이선스 발행', done: '④ 메일발송 완료', closed: '만료·취소' }

function fmtRow(r) {
  return `ID:${r.id} | 단계:${STAGE_LABEL[getStage(r)]} | ${r.name} (${r.email}${r.phone ? `, ${r.phone}` : ''}) | 제품:${r.product} | 신청기간:${r.requested_months === 0 ? '무료체험(7일)' : r.requested_months + '개월'}` +
    (r.start_date ? ` | 시작:${r.start_date}` : '') +
    (r.expire_date ? ` | 만료:${r.expire_date}` : '') +
    (r.license_key ? ` | 키:${r.license_key}` : '') +
    (r.note ? ` | 메모:${r.note}` : '')
}

const baseHandler = createMcpHandler(
  (server) => {
    // ── 라이선스 관리 툴 ──────────────────────────────────────────────

    server.registerTool(
      'list_licenses',
      {
        title: '라이선스 신청 목록 조회',
        description: '라이선스 신청/발급 내역을 조회한다. status로 필터링 가능(pending/active/expired/cancelled). 입금 확인 대기 중인 신청을 찾을 때 status:"pending"으로 조회한다.',
        inputSchema: {
          status: z.enum(['pending', 'active', 'expired', 'cancelled']).optional().describe('상태로 필터링. 비우면 전체 반환'),
          limit: z.number().int().min(1).max(200).optional().describe('가져올 행 수. 기본 50'),
        },
      },
      async ({ status, limit = 50 }) => {
        let q = supabase.from('licenses').select('*').order('created_at', { ascending: false }).limit(limit)
        if (status) q = q.eq('status', status)
        const { data, error } = await q
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        if (!data?.length) return { content: [{ type: 'text', text: '조회된 신청 내역 없음' }] }
        return { content: [{ type: 'text', text: data.map(fmtRow).join('\n') }] }
      }
    )

    server.registerTool(
      'issue_license',
      {
        title: '라이선스 키 발급',
        description: '입금 확인 후 pending 상태인 신청에 라이선스 키를 발급하고 status를 active로 바꾼다. 시작일은 오늘, 만료일은 신청 시 입력한 requested_months만큼 뒤로 자동 계산된다. 발급 전 반드시 실제 입금 확인이 됐는지 사람에게 확인할 것.',
        inputSchema: {
          id: z.string().describe('licenses 테이블의 id (list_licenses로 조회 후 사용)'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ id }) => {
        const { data: row, error: fetchErr } = await supabase.from('licenses').select('*').eq('id', id).maybeSingle()
        if (fetchErr) return { content: [{ type: 'text', text: `❌ ${fetchErr.message}` }], isError: true }
        if (!row) return { content: [{ type: 'text', text: `❌ id="${id}" 신청 내역을 찾을 수 없음` }], isError: true }
        const months = row.requested_months ?? 1
        const start = new Date().toISOString().slice(0, 10)
        const update = { status: 'active', license_key: genLicenseKey(), start_date: start, expire_date: computeExpireDate(start, months) }
        const { data, error } = await supabase.from('licenses').update(update).eq('id', id).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 라이선스 발급 완료\n${fmtRow(data)}\n\n이메일(${data.email})로 라이선스 키를 안내해야 한다: ${data.license_key}` }] }
      }
    )

    server.registerTool(
      'confirm_deposit',
      {
        title: '입금 확인 처리',
        description: '실제로 입금이 확인된 신청 건을 "② 입금확인" 단계로 넘긴다. 아직 키는 발급하지 않는다 (그 다음 issue_license 호출). 무료체험(requested_months=0)은 신청 즉시 자동으로 이 단계를 건너뛰므로 호출할 필요 없음.',
        inputSchema: {
          id: z.string().describe('licenses 테이블의 id'),
        },
      },
      async ({ id }) => {
        const { data, error } = await supabase.from('licenses')
          .update({ deposit_confirmed_at: new Date().toISOString() }).eq('id', id).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 입금 확인 처리 완료\n${fmtRow(data)}` }] }
      }
    )

    server.registerTool(
      'mark_email_sent',
      {
        title: '메일 발송 완료 처리',
        description: '라이선스 키를 신청자 이메일로 실제 발송한 뒤 "④ 메일발송 완료" 단계로 넘긴다. 실제 이메일 발송은 이 서버가 대신 해주지 않으므로, 직접 보낸 뒤에만 호출할 것.',
        inputSchema: {
          id: z.string().describe('licenses 테이블의 id'),
        },
      },
      async ({ id }) => {
        const { data, error } = await supabase.from('licenses')
          .update({ email_sent_at: new Date().toISOString() }).eq('id', id).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 메일 발송 완료 처리\n${fmtRow(data)}` }] }
      }
    )

    server.registerTool(
      'extend_license',
      {
        title: '라이선스 기간 연장',
        description: '기존 라이선스의 만료일을 지정한 개월 수만큼 연장한다. 이미 만료된 경우 오늘부터, 아직 유효한 경우 기존 만료일부터 계산해서 더한다. status가 active가 아니면 active로 바꾼다.',
        inputSchema: {
          id: z.string().describe('licenses 테이블의 id'),
          months: z.number().int().min(1).max(36).describe('연장할 개월 수'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ id, months }) => {
        const { data: row, error: fetchErr } = await supabase.from('licenses').select('*').eq('id', id).maybeSingle()
        if (fetchErr) return { content: [{ type: 'text', text: `❌ ${fetchErr.message}` }], isError: true }
        if (!row) return { content: [{ type: 'text', text: `❌ id="${id}" 라이선스를 찾을 수 없음` }], isError: true }
        const base = row.expire_date && new Date(row.expire_date) > new Date() ? row.expire_date : new Date().toISOString().slice(0, 10)
        const update = { status: 'active', expire_date: addMonths(base, months) }
        const { data, error } = await supabase.from('licenses').update(update).eq('id', id).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 연장 완료\n${fmtRow(data)}` }] }
      }
    )

    server.registerTool(
      'cancel_license',
      {
        title: '라이선스 취소',
        description: '라이선스를 cancelled 상태로 변경한다 (환불/부정사용 등). 데이터는 삭제되지 않는다.',
        inputSchema: {
          id: z.string().describe('licenses 테이블의 id'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ id }) => {
        const { data, error } = await supabase.from('licenses').update({ status: 'cancelled' }).eq('id', id).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 취소 처리 완료\n${fmtRow(data)}` }] }
      }
    )

    server.registerTool(
      'update_license_note',
      {
        title: '라이선스 메모 수정',
        description: '특정 신청 건에 관리자 메모를 남기거나 수정한다 (예: 입금자명 다름, 문의 내용 등).',
        inputSchema: {
          id: z.string().describe('licenses 테이블의 id'),
          note: z.string().describe('남길 메모 내용'),
        },
      },
      async ({ id, note }) => {
        const { data, error } = await supabase.from('licenses').update({ note }).eq('id', id).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 메모 저장 완료\n${fmtRow(data)}` }] }
      }
    )

    // ── 블로그 키워드 리서치 + 발행기록 툴 (fresh-season MCP 그대로 이식) ─────────

    server.registerTool(
      'naver_keyword_volume',
      {
        title: '네이버 키워드 실시간 검색량 조회',
        description:
          '네이버 검색광고 키워드도구로 키워드별 월간 검색량(PC/모바일 합산)과 경쟁정도를 실시간으로 ' +
          '조회한다. NAVER_CLIENT_ID/SECRET 환경변수가 설정되어 있으면 네이버 블로그 문서수(docCount)도 ' +
          '함께 반환된다. 조회 결과는 keyword_stats에 자동 저장되어 search_keyword_data로 다시 불러올 수 있다.',
        inputSchema: {
          hintKeywords: z.string().describe('쉼표로 구분된 한글 키워드 문자열, 최대 5개. 예: "매매전략,자동매매,HMA크로스"'),
        },
      },
      async ({ hintKeywords }) => {
        const keywords = normalizeKeywords(hintKeywords)
        if (keywords.length === 0) {
          return { content: [{ type: 'text', text: '키워드가 비어있습니다. 쉼표로 구분된 키워드를 1개 이상 입력해주세요.' }], isError: true }
        }
        try {
          const results = await fetchNaverKeywordData(keywords)
          const nowIso = nowKST()
          for (const hint of keywords) {
            const rows = results.filter(r => r.keyword).map(r => ({
              hint, keyword: r.keyword,
              pc: r.monthlySearchPc || 0, mobile: r.monthlySearchMobile || 0, total: r.monthlySearchTotal || 0,
              competition: r.competition || '-', created_at: nowIso,
            }))
            if (rows.length > 0) await supabase.from('keyword_stats').upsert(rows, { onConflict: 'hint,keyword' })
          }
          return { content: [{ type: 'text', text: JSON.stringify({ query: keywords, saved: results.length, results }, null, 2) }] }
        } catch (err) {
          return { content: [{ type: 'text', text: `오류: ${err.message || '키워드 조회 중 오류가 발생했습니다.'}` }], isError: true }
        }
      }
    )

    server.registerTool(
      'search_keyword_data',
      {
        title: '전체 키워드 데이터 검색/열람',
        description:
          'keyword_stats 테이블 전체를 검색·열람한다. query를 주면 키워드에 그 문자열이 포함된 것만, ' +
          '비우면 검색량 높은 순으로 전체를 반환한다. competition을 주면 그 경쟁도만 걸러서 본다 — ' +
          '예를 들어 competition:"낮음"으로 호출하면 위쪽이 곧 "검색량 높고 경쟁 낮은" 황금키워드 후보다.',
        inputSchema: {
          query: z.string().optional().describe('키워드에 포함될 부분 문자열. 비우면 전체 반환'),
          competition: z.string().optional().describe('경쟁도로 필터링 (예: "낮음")'),
          limit: z.number().int().min(1).max(300).optional().describe('최대 개수 (기본 100)'),
        },
      },
      async ({ query, competition, limit }) => {
        let q = supabase.from('keyword_stats').select('hint, keyword, pc, mobile, total, competition').order('total', { ascending: false }).limit(limit || 100)
        if (query) q = q.ilike('keyword', `%${query}%`)
        if (competition) q = q.eq('competition', competition)
        const { data, error } = await q
        if (error) return { content: [{ type: 'text', text: `오류: ${error.message}` }], isError: true }
        if (!data || !data.length) return { content: [{ type: 'text', text: '검색 결과 없음' }] }
        const lines = [`검색 결과 (${data.length}건, 검색량 순):`]
        data.forEach(k => lines.push(`- [${k.hint}] ${k.keyword} · 합계 ${fmt(k.total)} (PC ${fmt(k.pc)} / 모바일 ${fmt(k.mobile)})${k.competition ? ' · 경쟁도 ' + k.competition : ''}`))
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    )

    server.registerTool(
      'pick_keyword',
      {
        title: '키워드 찜하기 (나중에 쓸 글감 bookmark)',
        description:
          '검색량 높고 경쟁 낮은 "황금키워드"처럼 지금 당장은 안 쓰더라도 나중에 글로 쓰고 싶은 키워드를 ' +
          '찜해둔다(keyword_picks에 upsert). memo에 "이 키워드면 이런 글을 써야겠다"는 계획을 짧게 적어둔다.',
        inputSchema: {
          group: z.string().describe('이 키워드를 묶을 그룹 이름 (자유롭게 지정)'),
          keyword: z.string(),
          pc: z.number().optional(), mobile: z.number().optional(), total: z.number().optional(),
          competition: z.string().optional(),
          memo: z.string().optional().describe('어떤 글로 연결할지 계획 메모'),
        },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async ({ group, keyword, pc, mobile, total, competition, memo }) => {
        const row = {
          tool_id: group, hint: group, keyword,
          pc: pc || 0, mobile: mobile || 0, total: total != null ? total : (pc || 0) + (mobile || 0),
          competition: competition || null, memo: memo || null,
        }
        const { error } = await supabase.from('keyword_picks').upsert(row, { onConflict: 'tool_id,keyword' })
        if (error) return { content: [{ type: 'text', text: `오류: ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `⭐ 찜 완료: [${group}] ${keyword}${memo ? ' — ' + memo : ''}` }] }
      }
    )

    server.registerTool(
      'search_keyword_picks',
      {
        title: '찜한 키워드 전체 검색/열람',
        description:
          'pick_keyword로 찜해둔 키워드를 전체 열람·검색한다. 기본적으로 아직 글에 안 쓴(미사용) 키워드만 ' +
          '보여준다 — 글감을 정하기 전에 호출해서 "찜해둔 것 중 오늘 쓸 만한 게 있는지" 확인하면 좋다.',
        inputSchema: {
          query: z.string().optional().describe('키워드 또는 메모에 포함될 부분 문자열'),
          include_used: z.boolean().optional().describe('true면 이미 사용 처리된 키워드도 함께 보여준다 (기본 false)'),
        },
      },
      async ({ query, include_used }) => {
        let q = supabase.from('keyword_picks').select('tool_id, keyword, pc, mobile, total, competition, memo, used_at, used_in_title, used_in_slug').order('total', { ascending: false })
        if (!include_used) q = q.is('used_at', null)
        const { data, error } = await q
        if (error) return { content: [{ type: 'text', text: `오류: ${error.message}` }], isError: true }
        let rows = data || []
        if (query) {
          const needle = query.toLowerCase()
          rows = rows.filter(r => (r.keyword || '').toLowerCase().includes(needle) || (r.memo || '').toLowerCase().includes(needle))
        }
        if (!rows.length) return { content: [{ type: 'text', text: include_used ? '찜한 키워드 없음' : '미사용 찜 키워드 없음' }] }
        const label = include_used ? '찜한 키워드 (사용 여부 포함)' : '⭐ 미사용 찜 키워드'
        const lines = [`${label} (${rows.length}개):`]
        rows.forEach(p => {
          const usedNote = p.used_at ? ` · ✅ 사용됨(${p.used_at.slice(0, 10)}, ${p.used_in_title || p.used_in_slug || '글 정보 없음'})` : ''
          lines.push(`- [${p.tool_id}] ${p.keyword} · 합계 ${fmt(p.total)} (PC ${fmt(p.pc)} / 모바일 ${fmt(p.mobile)})${p.competition ? ' · 경쟁도 ' + p.competition : ''}${p.memo ? ' · 메모: ' + p.memo : ''}${usedNote}`)
        })
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    )

    server.registerTool(
      'mark_keyword_used',
      {
        title: '찜 키워드 사용 처리',
        description: '찜해둔 키워드를 실제로 글에 썼을 때 사용 처리한다 — used_at(날짜)·used_in_title/slug(어느 글)을 기록.',
        inputSchema: {
          group: z.string().describe('찜할 때 썼던 그룹 이름 (tool_id)'),
          keyword: z.string(),
          used_in_title: z.string().optional(),
          used_in_slug: z.string().optional(),
        },
      },
      async ({ group, keyword, used_in_title, used_in_slug }) => {
        const { data, error } = await supabase.from('keyword_picks')
          .update({ used_at: nowKST(), used_in_title: used_in_title || null, used_in_slug: used_in_slug || null })
          .eq('tool_id', group).eq('keyword', keyword).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        if (!data) return { content: [{ type: 'text', text: `❌ [${group}] ${keyword} 찜 기록을 찾을 수 없음` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 사용 처리 완료: [${group}] ${keyword}` }] }
      }
    )

    server.registerTool(
      'add_publish_log',
      {
        title: '블로그 발행 기록 추가',
        description:
          '새로 작성한 블로그 글 1편을 발행 기록에 남긴다. create_blog_post 호출 직후 함께 호출해서 ' +
          '같은 각도를 다음에 또 쓰지 않도록 한다. 이 글에서 pick_keyword로 찜해뒀던 키워드를 실제로 썼다면, ' +
          'memo에 어떤 키워드를 어떻게 썼는지 짧게 남긴다.',
        inputSchema: {
          category: z.string().optional().describe('카테고리. create_blog_post에 실제로 사용한 category 값과 동일하게'),
          angle: z.string().describe('글감 각도, 예: "전략 소개"'),
          title: z.string(), slug: z.string(),
          memo: z.string().optional(),
          target_keyword: z.string().optional(),
          search_pc: z.number().optional(), search_mobile: z.number().optional(), search_total: z.number().optional(),
          competition: z.string().optional(),
          google_indexing: z.string().optional(), index_now: z.string().optional(),
        },
        annotations: { destructiveHint: false, idempotentHint: false },
      },
      async ({ category, angle, title, slug, memo, target_keyword, search_pc, search_mobile, search_total, competition, google_indexing, index_now }) => {
        const row = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          category: category || null, angle, title, slug,
          memo: memo || null, target_keyword: target_keyword || null,
          search_pc: search_pc != null ? Number(search_pc) : null,
          search_mobile: search_mobile != null ? Number(search_mobile) : null,
          search_total: search_total != null ? Number(search_total) : null,
          competition: competition || null,
          google_indexing: google_indexing || null, index_now: index_now || null,
          published_at: nowKST(), created_at: nowKST(),
        }
        const { data, error } = await supabase.from('publish_log').insert([row]).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 기록 추가됨: ${category || '-'} / ${angle} / ${title}` }] }
      }
    )

    server.registerTool(
      'get_publish_log',
      {
        title: '블로그 발행 기록 조회',
        description: '지금까지 발행한 블로그 글 기록(각도/제목/슬러그/발행일/메모)을 가져온다. 글감을 정하기 전 중복을 피하는 데 쓴다.',
        inputSchema: {
          category: z.string().optional().describe('특정 카테고리로만 필터링'),
          limit: z.number().int().min(1).max(500).optional().describe('최대 개수 (기본 200)'),
        },
      },
      async ({ category, limit }) => {
        let q = supabase.from('publish_log').select('*').order('created_at', { ascending: false })
        if (category) q = q.eq('category', category)
        q = q.limit(limit || 200)
        const { data, error } = await q
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        if (!data || !data.length) return { content: [{ type: 'text', text: '발행 기록: 없음 (처음 시작)' }] }
        const lines = [`발행 기록 (${data.length}건, 최신순):`]
        data.forEach(l => {
          const dateStr = l.published_at || (l.created_at ? l.created_at.slice(0, 10) : '')
          lines.push(`- 카테고리: ${l.category || '-'} / 각도: ${l.angle} / 제목: ${l.title} / 슬러그: ${l.slug}${dateStr ? ' / 날짜: ' + dateStr : ''}${l.memo ? ' / 메모: ' + l.memo : ''}`)
        })
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    )

    // ── 블로그 관리 툴 (fresh-season 패턴을 trader용으로 축소) ────────────────

    server.registerTool(
      'list_blog_posts',
      {
        title: '블로그 글 목록 조회',
        description: '블로그 글 목록을 조회한다. status(draft/published)나 category로 필터링 가능.',
        inputSchema: {
          status: z.enum(['draft', 'published']).optional().describe('상태로 필터링. 비우면 전체'),
          category: z.string().optional().describe('카테고리로 필터링'),
          limit: z.number().int().min(1).max(200).optional().describe('가져올 행 수. 기본 50'),
        },
      },
      async ({ status, category, limit = 50 }) => {
        let q = supabase.from('blog_posts').select('*').order('created_at', { ascending: false }).limit(limit)
        if (status) q = q.eq('status', status)
        if (category) q = q.eq('category', category)
        const { data, error } = await q
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        if (!data?.length) return { content: [{ type: 'text', text: '조회된 글 없음' }] }
        const lines = data.map(p => `ID:${p.id} | ${p.status === 'published' ? '✅발행' : '📝임시'} | ${p.title} | 카테고리:${p.category || '-'} | slug:${p.slug}`)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    )

    server.registerTool(
      'create_blog_post',
      {
        title: '블로그 글 작성 (본문 포함, fresh-season 풀 기능 이식)',
        description:
          '블로그 글 본문 전체를 실제로 사이트에 올린다. 기본 상태는 published라 호출 즉시 공개된다. ' +
          'status를 draft로 주면 임시저장, scheduled로 주면 scheduled_at 시각에 자동 발행된다.',
        inputSchema: {
          title: z.string().describe('글 제목'),
          slug: z.string().describe('URL 슬러그 (영문 소문자+하이픈)'),
          content: z.string().describe('본문 (마크다운)'),
          category: z.string().optional().describe('카테고리. 예: 전략 / 공지 / 가이드 (list_blog_categories로 조회 가능)'),
          summary: z.string().optional().describe('목록·검색결과·SEO description에 쓰일 짧은 요약'),
          tags: z.array(z.string()).optional().describe('태그 5~8개 권장'),
          cover_image: z.string().optional().describe('커버 이미지 URL'),
          author: z.string().optional().describe('작성자 표시명. 비우면 기본값(트레이더 편집팀) 사용'),
          status: z.enum(['published', 'draft', 'scheduled']).optional().describe('기본값 published'),
          scheduled_at: z.string().optional().describe('status가 scheduled일 때만 사용, ISO 날짜'),
          title_score: z.number().optional().describe('제목 점수표(10점 만점) 채점 결과. 방문자에게는 노출되지 않고 관리자만 조회 가능.'),
          seo_score: z.number().optional().describe('SEO 체크리스트(100점 만점) 채점 결과. 방문자에게는 노출되지 않고 관리자만 조회 가능.'),
          title_score_detail: z.array(z.object({
            label: z.string(), points: z.number(), max: z.number(), reason: z.string(),
          })).optional().describe('제목 점수 항목별 배점·이유 breakdown. title_score를 줄 때 항상 함께 채운다.'),
          seo_score_detail: z.array(z.object({
            label: z.string(), points: z.number(), max: z.number(), pass: z.boolean(), desc: z.string(),
          })).optional().describe('SEO 체크리스트 항목별 배점·통과여부·이유 breakdown. seo_score를 줄 때 항상 함께 채운다.'),
          naver_summary: z.string().optional().describe('네이버 블로그에 붙여넣을 요약글(300~500자 + 원문 링크). 관리자만 조회 가능.'),
          instagram_cards: z.string().optional().describe('인스타그램 카드뉴스 슬라이드 스크립트(4~6장). 관리자만 조회 가능.'),
        },
        annotations: { destructiveHint: false, idempotentHint: false },
      },
      async ({ title, slug, content, category = '', summary = '', tags, cover_image, author, status = 'published', scheduled_at, title_score, seo_score, title_score_detail, seo_score_detail, naver_summary, instagram_cards }) => {
        const nowIso = nowKST()
        const row = {
          id: randomUUID(), post_type: 'blog', title, slug, content, category,
          summary: summary || null, tags: Array.isArray(tags) ? tags : [], cover_image: cover_image || null,
          author_name: (author && String(author).trim()) || '트레이더 편집팀',
          status,
          scheduled_at: status === 'scheduled' ? (scheduled_at || null) : null,
          published_at: status === 'published' ? nowIso : null,
          created_at: nowIso, updated_at: nowIso,
          title_score: title_score ?? null, seo_score: seo_score ?? null,
          title_score_detail: title_score_detail ?? null, seo_score_detail: seo_score_detail ?? null,
          naver_summary: naver_summary ?? null, instagram_cards: instagram_cards ?? null,
        }
        const { data, error } = await supabase.from('blog_posts').insert([row]).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }

        const indexing = { google: null, indexnow: null }
        if (status === 'published') {
          const pageUrl = `${SITE_URL}/blog/${data.slug}`
          try {
            if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 미설정')
            const { GoogleAuth } = await import('google-auth-library')
            const gauth = new GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ['https://www.googleapis.com/auth/indexing'] })
            const client = await gauth.getClient()
            const r = await client.request({ url: 'https://indexing.googleapis.com/v3/urlNotifications:publish', method: 'POST', data: { url: pageUrl, type: 'URL_UPDATED' } })
            indexing.google = { ok: true, status: r.status }
          } catch (e) { indexing.google = { ok: false, error: e?.response?.data || e?.message || String(e) } }
          try {
            if (!process.env.INDEXNOW_KEY) throw new Error('INDEXNOW_KEY 미설정')
            const r = await fetch('https://api.indexnow.org/indexnow', {
              method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ host: new URL(SITE_URL).host, key: process.env.INDEXNOW_KEY, keyLocation: `${SITE_URL}/${process.env.INDEXNOW_KEY}.txt`, urlList: [pageUrl] }),
            })
            indexing.indexnow = { ok: r.ok, status: r.status }
          } catch (e) { indexing.indexnow = { ok: false, error: e.message } }
        }

        return { content: [{ type: 'text', text: `✅ 작성 완료 (ID:${data.id})\n${status === 'published' ? `/blog/${data.slug} 에 발행됨` : status === 'scheduled' ? `${scheduled_at}에 예약발행 설정됨` : '임시저장됨'}\n색인요청 — google:${JSON.stringify(indexing.google)} indexnow:${JSON.stringify(indexing.indexnow)}` }] }
      }
    )

    server.registerTool(
      'update_blog_post',
      {
        title: '블로그 글 수정',
        description: '기존 블로그 글의 내용이나 상태를 수정한다 (예: draft → published 전환, 예약발행 설정 등). id는 list_blog_posts로 조회.',
        inputSchema: {
          id: z.string().describe('blog_posts 테이블의 id'),
          title: z.string().optional(),
          slug: z.string().optional(),
          content: z.string().optional(),
          category: z.string().optional(),
          summary: z.string().optional(),
          tags: z.array(z.string()).optional(),
          cover_image: z.string().optional(),
          status: z.enum(['published', 'draft', 'scheduled']).optional(),
          scheduled_at: z.string().optional(),
          title_score: z.number().optional(),
          seo_score: z.number().optional(),
          title_score_detail: z.array(z.object({ label: z.string(), points: z.number(), max: z.number(), reason: z.string() })).optional(),
          seo_score_detail: z.array(z.object({ label: z.string(), points: z.number(), max: z.number(), pass: z.boolean(), desc: z.string() })).optional(),
          naver_summary: z.string().optional(),
          instagram_cards: z.string().optional(),
        },
      },
      async ({ id, ...updates }) => {
        if (updates.status === 'published' && !updates.published_at) updates.published_at = nowKST()
        updates.updated_at = nowKST()
        const { data, error } = await supabase.from('blog_posts').update(updates).eq('id', id).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 수정 완료\nID:${data.id} | ${data.status === 'published' ? '✅발행' : data.status === 'scheduled' ? '⏰예약' : '📝임시'} | ${data.title}` }] }
      }
    )

    server.registerTool(
      'list_blog_categories',
      {
        title: '블로그 카테고리 목록 조회',
        description: '등록된 블로그 커스텀 카테고리 목록을 조회한다. create_blog_post 호출 전 어떤 category 값을 쓸 수 있는지 확인할 때 사용.',
        inputSchema: {},
      },
      async () => {
        const { data, error } = await supabase.from('blog_categories').select('*').order('label')
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        if (!data?.length) return { content: [{ type: 'text', text: '등록된 카테고리 없음 — 자유 텍스트로 category를 지정해도 됨' }] }
        return { content: [{ type: 'text', text: data.map(c => `${c.icon || '📁'} ${c.label}`).join('\n') }] }
      }
    )

    // ── Claude 시스템 프롬프트 툴 (fresh-season 이식) ─────────────────────────
    const SYSTEM_PROMPT_IDS = ['claude', 'main', 'main2', 'month']

    server.registerTool(
      'get_system_prompt',
      {
        title: 'Claude 시스템 프롬프트 조회',
        description: 'admin의 "Claude 지침" 탭에 저장해둔 지침을 불러온다. id를 안 주면 main 탭을 반환한다.',
        inputSchema: {
          id: z.enum(SYSTEM_PROMPT_IDS).optional().describe('claude(클로드 실행지침)/main(블로그 글작성지침)/main2(블로그 글작성지침 보조)/month(글감관리 월기획지침). 기본: main'),
        },
      },
      async ({ id }) => {
        const resolvedId = SYSTEM_PROMPT_IDS.includes(id) ? id : 'main'
        const { data, error } = await supabase.from('system_prompts').select('content, updated_at').eq('id', resolvedId).single()
        if (error || !data) return { content: [{ type: 'text', text: '(저장된 지침 없음)' }] }
        return { content: [{ type: 'text', text: data.content || '(내용 비어있음)' }] }
      }
    )

    server.registerTool(
      'update_system_prompt',
      {
        title: 'Claude 시스템 프롬프트 갱신',
        description: 'admin의 "Claude 지침" 탭 내용을 덮어쓴다. 사용자가 대화 중 직접 지침 변경을 요청했을 때만 호출한다.',
        inputSchema: {
          id: z.enum(SYSTEM_PROMPT_IDS).describe('claude/main/main2/month 중 어느 탭을 갱신할지'),
          content: z.string().describe('새 지침 전체 내용 (마크다운)'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ id, content }) => {
        const nowIso = nowKST()
        const { error } = await supabase.from('system_prompts').upsert({ id, content, updated_at: nowIso }, { onConflict: 'id' })
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ "${id}" 지침 저장 완료` }] }
      }
    )

    // ── GitHub 저장소 확인 툴 ────────────────────────────────────────────
    // trader 저장소(minssajang/trader)에 실제로 어떤 파일이 올라가 있는지 확인할 때 쓴다.
    // 공개 저장소라 토큰 없이도 동작하지만(시간당 60회 제한), GITHUB_TOKEN 환경변수를
    // 등록해두면 그 제한이 훨씬 늘어난다.

    server.registerTool(
      'list_github_files',
      {
        title: 'GitHub 저장소 파일 목록 조회',
        description: 'minssajang/trader 저장소의 특정 경로에 어떤 파일·폴더가 있는지 조회한다. path를 비우면 저장소 루트를 본다. GitHub에 실제로 무엇이 올라가 있는지 확인할 때 사용.',
        inputSchema: {
          path: z.string().optional().describe('조회할 경로. 예: "pages" 또는 "app/api/mcp". 비우면 루트'),
          ref: z.string().optional().describe('브랜치/커밋. 기본: main'),
        },
      },
      async ({ path = '', ref = 'main' }) => {
        const url = `https://api.github.com/repos/minssajang/trader/contents/${path}?ref=${encodeURIComponent(ref)}`
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'trader-mcp' }
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
        const res = await fetch(url, { headers })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          return { content: [{ type: 'text', text: `❌ GitHub API 오류 (${res.status}): ${text}` }], isError: true }
        }
        const data = await res.json()
        const list = Array.isArray(data) ? data : [data]
        const lines = list.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.path}${f.type === 'file' ? ` (${f.size} bytes)` : ''}`)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    )

    server.registerTool(
      'get_github_file',
      {
        title: 'GitHub 저장소 파일 내용 조회',
        description: 'minssajang/trader 저장소의 특정 파일 내용을 텍스트로 가져온다. list_github_files로 경로 확인 후 사용. 100KB 넘는 파일은 GitHub API 제약으로 못 가져올 수 있다.',
        inputSchema: {
          path: z.string().describe('파일 경로. 예: "pages/admin.js"'),
          ref: z.string().optional().describe('브랜치/커밋. 기본: main'),
        },
      },
      async ({ path, ref = 'main' }) => {
        const url = `https://api.github.com/repos/minssajang/trader/contents/${path}?ref=${encodeURIComponent(ref)}`
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'trader-mcp' }
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
        const res = await fetch(url, { headers })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          return { content: [{ type: 'text', text: `❌ GitHub API 오류 (${res.status}): ${text}` }], isError: true }
        }
        const data = await res.json()
        if (data.type !== 'file') return { content: [{ type: 'text', text: `❌ "${path}"는 파일이 아니라 ${data.type}입니다` }], isError: true }
        const content = Buffer.from(data.content, data.encoding || 'base64').toString('utf-8')
        return { content: [{ type: 'text', text: `[${path}] (${data.size} bytes)\n\n${content}` }] }
      }
    )

    // ── Supabase 직접 조회·수정 툴 (fresh-season과 동일 패턴) ──────────────

    server.registerTool(
      'list_tables',
      {
        title: 'DB 테이블 목록 조회',
        description: 'list_tables — DB 테이블 목록 조회. trader Supabase DB에 있는 테이블 목록을 반환한다.',
        inputSchema: {
          schema: z.string().optional().describe('스키마 이름. 기본값: public'),
        },
      },
      async ({ schema = 'public' }) => {
        const { data, error } = await supabase
          .from('information_schema.tables')
          .select('table_name')
          .eq('table_schema', schema)
          .eq('table_type', 'BASE TABLE')
          .order('table_name')
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        const names = (data || []).map(r => r.table_name).join('\n')
        return { content: [{ type: 'text', text: `테이블 목록 (${schema} 스키마):\n${names}` }] }
      }
    )

    server.registerTool(
      'get_rows',
      {
        title: 'DB 테이블 데이터 조회',
        description: 'get_rows — DB 테이블 데이터 조회. 특정 테이블의 행을 조회한다. 필터·텍스트검색·정렬·페이징 지원, 최대 500행.',
        inputSchema: {
          table: z.string().describe('테이블 이름. 예: licenses, settings'),
          select: z.string().optional().describe('가져올 컬럼 (쉼표 구분). 비우면 전체(*)'),
          filter: z.record(z.string()).optional().describe('eq 필터. 예: {"status":"pending"}'),
          search_column: z.string().optional().describe('텍스트 검색할 컬럼. search_value와 함께 사용'),
          search_value: z.string().optional().describe('텍스트 검색어 (ilike, 부분일치)'),
          order_by: z.string().optional().describe('정렬 기준 컬럼. 기본: created_at'),
          ascending: z.boolean().optional().describe('오름차순 여부. 기본: false (최신순)'),
          limit: z.number().int().min(1).max(500).optional().describe('가져올 행 수. 기본 50, 최대 500'),
          offset: z.number().int().min(0).optional().describe('건너뛸 행 수 (페이징). 기본 0'),
        },
      },
      async ({ table, select = '*', filter, search_column, search_value, order_by = 'created_at', ascending = false, limit = 50, offset = 0 }) => {
        let q = supabase.from(table).select(select)
        if (filter) { for (const [col, val] of Object.entries(filter)) q = q.eq(col, val) }
        if (search_column && search_value) q = q.ilike(search_column, `%${search_value}%`)
        q = q.order(order_by, { ascending }).range(offset, offset + limit - 1)
        const { data, error } = await q
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        if (!data?.length) return { content: [{ type: 'text', text: `(결과 없음) 테이블: ${table}` }] }
        return { content: [{ type: 'text', text: `[${table}] ${data.length}행 반환 (offset:${offset})\n${JSON.stringify(data, null, 2)}` }] }
      }
    )

    server.registerTool(
      'upsert_row',
      {
        title: 'DB 행 추가·수정',
        description: 'upsert_row — DB 행 추가·수정. 테이블에 행을 추가하거나 수정한다. id를 포함하면 수정(upsert), 없으면 새 행 추가.',
        inputSchema: {
          table: z.string().describe('테이블 이름'),
          row: z.record(z.any()).describe('추가·수정할 데이터 객체'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ table, row }) => {
        const { data, error } = await supabase.from(table).upsert([row], { onConflict: 'id' }).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ [${table}] upsert 완료\n${JSON.stringify(data, null, 2)}` }] }
      }
    )

    server.registerTool(
      'delete_row',
      {
        title: 'DB 행 삭제',
        description: 'delete_row — DB 행 삭제. 테이블에서 특정 id의 행을 삭제한다. 삭제 전 존재 자동 확인, 되돌릴 수 없음.',
        inputSchema: {
          table: z.string().describe('테이블 이름'),
          id: z.string().describe('삭제할 행의 id'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ table, id }) => {
        const { data: existing } = await supabase.from(table).select('id').eq('id', id).maybeSingle()
        if (!existing) return { content: [{ type: 'text', text: `❌ [${table}] id="${id}" 행을 찾을 수 없음` }], isError: true }
        const { error } = await supabase.from(table).delete().eq('id', id)
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ [${table}] id="${id}" 삭제 완료` }] }
      }
    )

    server.registerTool(
      'run_sql',
      {
        title: 'SQL 직접 실행',
        description: 'run_sql — SQL 직접 실행. 복잡한 조회나 수정이 필요할 때 SQL 쿼리를 직접 실행한다. DROP·TRUNCATE·ALTER 등 위험 DDL은 자동 차단.',
        inputSchema: {
          sql: z.string().describe('실행할 SQL 쿼리. 예: SELECT * FROM licenses WHERE status = \'pending\' ORDER BY created_at'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ sql }) => {
        const upper = sql.trim().toUpperCase()
        const dangerous = ['DROP ', 'TRUNCATE ', 'ALTER TABLE', 'CREATE TABLE', 'GRANT ', 'REVOKE ']
        if (dangerous.some(kw => upper.startsWith(kw) || upper.includes('\n' + kw))) {
          return { content: [{ type: 'text', text: `⛔ 위험한 DDL/권한 쿼리는 차단됩니다: ${sql.slice(0, 80)}` }], isError: true }
        }
        const { data, error } = await supabase.rpc('run_sql_query', { sql })
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}\n\nSQL: ${sql}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ SQL 실행 완료\n${JSON.stringify(data, null, 2)}` }] }
      }
    )
  },
  {
    instructions:
      '매매 시스템(trader) 라이선스 관리 서버. 라이선스 신청 조회/발급/연장/취소 도구와 ' +
      '블로그 글 관리 도구(list_blog_posts/create_blog_post/update_blog_post/list_blog_categories), ' +
      '블로그 키워드 리서치·발행기록 도구(naver_keyword_volume/search_keyword_data/pick_keyword/' +
      'search_keyword_picks/mark_keyword_used/add_publish_log/get_publish_log), ' +
      'Claude 시스템 프롬프트 도구(get_system_prompt/update_system_prompt), ' +
      'DB 직접 조회·수정 도구(list_tables/get_rows/upsert_row/delete_row/run_sql), ' +
      'GitHub 저장소(minssajang/trader) 파일 확인 도구(list_github_files/get_github_file)를 제공한다. ' +
      '입금 확인 후 issue_license로 키를 발급하고, 발급된 키는 반드시 신청자 이메일로 안내해야 한다.',
  },
  { basePath: '/api', maxDuration: 30, verboseLogs: true }
)

// claude.ai 커스텀 커넥터가 인증 없는 MCP 서버에 연결할 때 강제로 OAuth 등록(DCR)을
// 시도했다가 실패하는 버그가 있어(Anthropic 이슈 #402/#413/#457), 스펙에 어긋나더라도
// 연결 자체는 되는 ?key= 쿼리파라미터 방식을 사용한다 (fresh-season과 동일한 이유).
async function authedHandler(request) {
  const url = new URL(request.url)
  const key = url.searchParams.get('key')
  if (!process.env.MCP_SHARED_SECRET || key !== process.env.MCP_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: '인증 필요 (key 파라미터 확인)' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return baseHandler(request)
}

export { authedHandler as GET, authedHandler as POST }
