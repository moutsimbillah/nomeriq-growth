'use client';

import { useEffect, useState, useId, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { RecipientPolicy } from '@/lib/services/recipient-policy';

export function LeadReplyRecipient({ prospectId }: { prospectId: string }) {
  const router = useRouter();
  const activeProspectId = useRef(prospectId);
  activeProspectId.current = prospectId;
  const id = useId();
  const [policy, setPolicy] = useState<RecipientPolicy | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const url = `/api/leads/${prospectId}/reply-recipient`;
  useEffect(() => {
    let active = true;
    setPolicy(null); setStatus(''); setBusy(false);
    fetch(url, { cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not load reply addresses.');
      if (active) { setPolicy(result.data); setSelected(result.data.preferredEmailId ?? ''); }
    }).catch(error => { if (active) setStatus(error.message); });
    return () => { active = false; };
  }, [url]);
  async function save() {
    setBusy(true); setStatus('');
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emailRowId: selected || null }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not save recipient.');
      const readback = await fetch(url, { cache: 'no-store' });
      const verified = await readback.json();
      if (!readback.ok || (verified.data.preferredEmailId ?? '') !== selected) throw new Error('Preference submitted; reload to verify.');
      if (activeProspectId.current !== prospectId) return;
      setPolicy(verified.data); setStatus('Reply preference recorded. Nothing sent.'); router.refresh();
    } catch (error) { if (activeProspectId.current === prospectId) setStatus(error instanceof Error ? error.message : 'Request failed.'); }
    finally { if (activeProspectId.current === prospectId) setBusy(false); }
  }
  return <section aria-label="Reply recipient" className="min-w-0 space-y-3 rounded-xl border border-line bg-paper/50 p-3.5 text-12 leading-5 text-muted">
    <h2 className="text-13 font-bold text-ink">Reply recipient · retained addresses</h2>
    <dl className="min-w-0 space-y-1 break-anywhere [&>dt]:font-semibold [&>dt]:text-ink"><dt>First contacted</dt><dd>{policy?.firstContact ?? 'Not recorded'}</dd><dt>Now writing from (stored address)</dt><dd>{policy?.currentWritingFrom ?? 'No linked real sender'}</dd><dt>Reply to</dt><dd>{policy?.recipient ?? (policy ? 'Blocked / no eligible address' : 'Loading reply addresses…')}</dd></dl>
    {policy?.reason && <p role={policy.blocked ? 'alert' : undefined}>{policy.reason}</p>}
    <label className="block font-semibold text-ink" htmlFor={id}>Reply address preference</label>
    <select className="block w-full min-w-0 max-w-full truncate rounded-lg border border-line bg-paper px-3 py-2 text-12 text-ink" id={id} value={selected} disabled={!policy || busy} onChange={e => setSelected(e.target.value)}>
      <option value="">Default: latest real linked sender, then eligible stored address</option>
      {policy?.emails.map(email => <option key={email.id} value={email.id} disabled={email.blocked}>{email.email}{email.blocked ? ' — blocked' : ''}</option>)}
    </select>
    <button className="btn-secondary btn-xs" type="button" disabled={!policy || busy} onClick={() => void save()}>Save reply address</button>
    <ul className="min-w-0 space-y-2 break-anywhere">{policy?.emails.map(email => <li key={email.id}><span className="font-semibold text-ink">{email.email}</span> — {email.sourceType === 'founder_entered' && email.sourceUrl.startsWith('Linked by founder from message ') ? email.sourceUrl : `Source: ${email.sourceType} · ${email.sourceUrl}`}{!email.linked ? ' · Association removed; evidence retained' : ''}{email.reason ? ` · ${email.reason}` : ''}</li>)}</ul>
    <p role="status" aria-live="polite">{busy ? 'Saving…' : status}</p>
  </section>;
}
