'use client';

import { useEffect, useRef, useState } from 'react';

interface Summary {
  files: { interval: number; demand: number };
  rows: number; ignoredRows: number;
  from: string | null; to: string | null;
  intervals: number; estimated: number;
  importIntervals: number; exportIntervals: number; demandIntervals: number;
  missingDays: string[]; missingDayCount: number;
  peak: { kw: number; at: string } | null;
}
type Phase = 'pick' | 'parsing' | 'preview' | 'writing' | 'done';

const fmt = (n: number) => n.toLocaleString('en-US');

export default function EnergyUploadPage() {
  const [phase, setPhase] = useState<Phase>('pick');
  const [names, setNames] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ intervals: number; days: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
    document.documentElement.style.height = 'auto';
    document.body.style.height = 'auto';
    return () => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      document.documentElement.style.height = '';
      document.body.style.height = '';
    };
  }, []);

  function reset() {
    setPhase('pick'); setSummary(null); setToken(''); setError(''); setResult(null); setNames([]);
    if (input.current) input.current.value = '';
  }

  async function upload(files: FileList | null) {
    if (!files || !files.length) return;
    setError(''); setNames([...files].map(f => f.name)); setPhase('parsing');
    const body = new FormData();
    for (const f of files) body.append('files', f);
    try {
      const res = await fetch('/api/energy-upload', { method: 'POST', body });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Upload failed.');
      setSummary(j.summary); setToken(j.token); setPhase('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.'); setPhase('pick');
    }
  }

  async function confirm() {
    setError(''); setPhase('writing');
    try {
      const res = await fetch('/api/energy-upload/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Import failed.');
      setResult(j); setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.'); setPhase('preview');
    }
  }

  const s = summary;
  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <div className="admin-title">NV Energy import</div>
          <div className="admin-subtitle">Add the interval and demand CSVs from NV Energy to InfluxDB.</div>
        </div>
        <a href="/" className="btn-secondary">
          <span className="icon" style={{ fontSize: 16 }}>arrow_back</span>
          Dashboard
        </a>
      </div>

      {error && <div className="nve-error" role="alert">{error}</div>}

      {(phase === 'pick' || phase === 'parsing') && (
        <div className="admin-section">
          <div className="admin-section-body">
            <label className={'nve-drop' + (phase === 'parsing' ? ' busy' : '')}>
              <span className="icon" style={{ fontSize: 32 }}>{phase === 'parsing' ? 'hourglass_top' : 'upload_file'}</span>
              <span className="nve-drop-title">{phase === 'parsing' ? 'Reading ' + names.join(', ') : 'Choose the CSV files'}</span>
              <span className="form-hint">The interval file and the demand file can go in together. ZIP files are not supported, so unzip first.</span>
              <input ref={input} type="file" accept=".csv,text/csv" multiple disabled={phase === 'parsing'}
                onChange={e => upload(e.target.files)} />
            </label>
            <div className="form-hint">
              Names, addresses and account numbers are dropped while the file is read. The file is not saved: it is held in memory until you confirm.
            </div>
          </div>
        </div>
      )}

      {s && (phase === 'preview' || phase === 'writing') && (
        <div className="admin-section">
          <div className="admin-section-header">
            <div className="admin-section-title"><span className="icon" style={{ fontSize: 18 }}>fact_check</span>Preview</div>
            <span className="form-hint mono">{names.join(' + ')}</span>
          </div>
          <div className="admin-section-body">
            {s.peak && (
              <div className="nve-peak">
                <span className="nve-peak-num mono">{s.peak.kw.toFixed(1)}</span>
                <span className="nve-peak-unit">kW highest demand<br /><span className="mono">{s.peak.at}</span></span>
              </div>
            )}
            <div className="nve-stats">
              <div><div className="nve-k">Date range</div><div className="nve-v mono">{s.from} to {s.to}</div></div>
              <div><div className="nve-k">Intervals</div><div className="nve-v mono">{fmt(s.intervals)}</div></div>
              <div><div className="nve-k">Estimated</div><div className="nve-v mono">{fmt(s.estimated)}</div></div>
              <div><div className="nve-k">With export</div><div className="nve-v mono">{fmt(s.exportIntervals)}</div></div>
              <div><div className="nve-k">With demand kW</div><div className="nve-v mono">{fmt(s.demandIntervals)}</div></div>
            </div>
            <div>
              <div className="nve-k">Missing days</div>
              {s.missingDayCount === 0
                ? <div className="form-hint" style={{ marginTop: 4 }}>None. Every day in the range has data.</div>
                : <div className="nve-chips">
                    {s.missingDays.map(d => <span key={d} className="nve-chip mono">{d}</span>)}
                    {s.missingDayCount > s.missingDays.length && <span className="form-hint">and {s.missingDayCount - s.missingDays.length} more</span>}
                  </div>}
            </div>
            {s.ignoredRows > 0 && <div className="form-hint">{fmt(s.ignoredRows)} rows were skipped (other channels or blank readings).</div>}
            <div className="form-hint">
              Writing replaces any points already stored for the same 15-minute intervals, so uploading the same file again is safe.
            </div>
            <div className="nve-actions">
              <button className="btn-primary" onClick={confirm} disabled={phase === 'writing'}>
                <span className="icon" style={{ fontSize: 16 }}>cloud_upload</span>
                {phase === 'writing' ? 'Writing to InfluxDB' : `Write ${fmt(s.intervals)} intervals`}
              </button>
              <button className="btn-secondary" onClick={reset} disabled={phase === 'writing'}>Choose other files</button>
            </div>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="admin-section">
          <div className="admin-section-body">
            <div className="admin-section-title"><span className="status-dot connected" />Imported</div>
            <div className="nve-v mono">{fmt(result.intervals)} intervals and {fmt(result.days)} daily peaks written.</div>
            <div className="nve-actions"><button className="btn-secondary" onClick={reset}>Import more files</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
