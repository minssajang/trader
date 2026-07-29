import { useState, useEffect, useRef } from 'react'
import { S, ConfirmModal } from './AdminUI'
import { publicSupabase } from '../../lib/publicSupabase'
import { parseCandleCsv } from '../../lib/candleCsv'

const BUCKET = 'backtest-data'

export default function BacktestDataPanel({ adminToken, showToast, symbol, title }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [queue, setQueue] = useState([]) // [{name, status, message}]
  const [confirmTarget, setConfirmTarget] = useState(null)
  const fileInputRef = useRef(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/backtest-datasets', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setRows((data.rows || []).filter(r => r.symbol === symbol))
    } catch {
      showToast?.('❌ 목록을 불러오지 못했습니다')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [symbol])

  const setQueueItem = (name, patch) => {
    setQueue(q => q.map(item => (item.name === name ? { ...item, ...patch } : item)))
  }

  const uploadOne = async (file) => {
    setQueueItem(file.name, { status: '분석 중...' })
    let parsed
    try {
      const text = await file.text()
      parsed = parseCandleCsv(text)
    } catch (e) {
      setQueueItem(file.name, { status: '실패', message: e.message })
      return
    }

    setQueueItem(file.name, { status: '업로드 URL 발급 중...' })
    let signed
    try {
      const res = await fetch('/api/admin/backtest-upload-sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ symbol, filename: file.name }),
      })
      signed = await res.json()
      if (!res.ok) throw new Error(signed.error || 'URL 발급 실패')
    } catch (e) {
      setQueueItem(file.name, { status: '실패', message: e.message })
      return
    }

    setQueueItem(file.name, { status: '업로드 중...' })
    try {
      const { error } = await publicSupabase.storage
        .from(BUCKET)
        .uploadToSignedUrl(signed.path, signed.token, file)
      if (error) throw error
    } catch (e) {
      setQueueItem(file.name, { status: '실패', message: e.message })
      return
    }

    setQueueItem(file.name, { status: '기록 중...' })
    try {
      const res = await fetch('/api/admin/backtest-datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({
          symbol,
          filename: file.name,
          storage_path: signed.path,
          row_count: parsed.rows.length,
          date_from: parsed.dateFrom,
          date_to: parsed.dateTo,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '기록 실패')
      setQueueItem(file.name, { status: '완료' })
    } catch (e) {
      setQueueItem(file.name, { status: '실패', message: e.message })
    }
  }

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList).filter(f => /\.csv$/i.test(f.name))
    if (files.length === 0) {
      showToast?.('❌ CSV 파일만 업로드할 수 있습니다')
      return
    }
    setQueue(files.map(f => ({ name: f.name, status: '대기 중' })))
    for (const file of files) {
      await uploadOne(file)
    }
    await load()
    showToast?.('✅ 업로드 처리 완료')
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files)
  }

  const remove = async (id) => {
    try {
      const res = await fetch('/api/admin/backtest-datasets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error()
      await load()
      showToast?.('✅ 삭제되었습니다')
    } catch {
      showToast?.('❌ 삭제 실패')
    }
  }

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>{title} ({rows.length})</div>
      <p style={{ color: '#9aa0ab', fontSize: 13, marginBottom: 16 }}>
        시가/고가/저가/종가와 시간이 있는 1분봉 CSV 파일을 여러 개 한번에 드래그해서 놓으면 자동으로 분석해서 등록해요.
      </p>

      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? '#4CAF50' : '#2a2e38'}`,
          borderRadius: 12, padding: '36px 20px', textAlign: 'center',
          cursor: 'pointer', background: dragOver ? 'rgba(76,175,80,0.08)' : '#0f1115',
          marginBottom: 16, transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 8 }}>📥</div>
        <div style={{ color: '#e8eaed', fontSize: 14, fontWeight: 600 }}>여기에 CSV 파일을 드래그하세요 (여러 개 가능)</div>
        <div style={{ color: '#9aa0ab', fontSize: 12, marginTop: 4 }}>또는 클릭해서 선택</div>
        <input
          ref={fileInputRef} type="file" accept=".csv" multiple style={{ display: 'none' }}
          onChange={e => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }}
        />
      </div>

      {queue.length > 0 && (
        <div style={{ ...S.row, marginBottom: 16 }}>
          {queue.map(item => (
            <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', color: item.status === '실패' ? '#F44336' : item.status === '완료' ? '#4CAF50' : '#9aa0ab' }}>
              <span>{item.name}{item.message ? ` — ${item.message}` : ''}</span>
              <span>{item.status}</span>
            </div>
          ))}
        </div>
      )}

      {loading && <div style={{ color: '#9aa0ab', fontSize: 14 }}>불러오는 중...</div>}
      {!loading && rows.length === 0 && <div style={{ color: '#9aa0ab', fontSize: 14 }}>등록된 데이터가 없습니다</div>}

      {!loading && rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {rows.map(r => (
            <div key={r.id} style={{ ...S.row, marginBottom: 0, position: 'relative' }}>
              <button onClick={() => setConfirmTarget(r)} style={{
                position: 'absolute', top: 8, right: 8, background: 'none', border: 'none',
                color: '#F44336', cursor: 'pointer', fontSize: 14, fontWeight: 700,
              }}>✕</button>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#e8eaed', marginBottom: 4, paddingRight: 20, wordBreak: 'break-all' }}>{r.filename}</div>
              <div style={{ fontSize: 12, color: '#9aa0ab' }}>{r.date_from} ~ {r.date_to}</div>
              <div style={{ fontSize: 12, color: '#9aa0ab' }}>{(r.row_count || 0).toLocaleString()}봉</div>
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!confirmTarget}
        title="데이터 삭제"
        message={confirmTarget ? `${confirmTarget.filename}을(를) 삭제할까요?` : ''}
        danger
        confirmLabel="삭제"
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => { remove(confirmTarget.id); setConfirmTarget(null) }}
      />
    </div>
  )
}
