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
//
// claude.ai 커스텀 커넥터 등록 URL:
//   https://<vercel-deployment>.vercel.app/api/mcp?key=여기에_MCP_SHARED_SECRET_값
//
// run_sql / list_tables 툴이 쓰는 run_sql_query RPC 함수는 sql/002_settings_and_admin.sql에 정의돼 있다.
// (Supabase SQL Editor에서 최초 1회 실행 필요)

import { createMcpHandler } from 'mcp-handler'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { randomUUID } from 'crypto'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function addMonths(dateStr, months) {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

function genLicenseKey() {
  return randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase().replace(/(.{5})/g, '$1-').replace(/-$/, '')
}

function fmtRow(r) {
  return `ID:${r.id} | ${r.name} (${r.email}) | 제품:${r.product} | 상태:${r.status} | 신청기간:${r.requested_months}개월` +
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
        const months = row.requested_months || 1
        const start = new Date().toISOString().slice(0, 10)
        const update = { status: 'active', license_key: genLicenseKey(), start_date: start, expire_date: addMonths(start, months) }
        const { data, error } = await supabase.from('licenses').update(update).eq('id', id).select().single()
        if (error) return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true }
        return { content: [{ type: 'text', text: `✅ 라이선스 발급 완료\n${fmtRow(data)}\n\n이메일(${data.email})로 라이선스 키를 안내해야 한다: ${data.license_key}` }] }
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
      'DB 직접 조회·수정 도구(list_tables/get_rows/upsert_row/delete_row/run_sql)를 제공한다. ' +
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
