'use client';

import { useEffect, useRef, useState, useId } from 'react';
import { useRouter } from 'next/navigation';
import type { LinkCandidate } from '@/lib/services/message-linking';

type Data = { currentProspectId: string | null; eligible: boolean; suggestions: LinkCandidate[]; search: LinkCandidate[] };
export function MessageLinkActions({ messageId, currentProspectId }: { messageId: string; currentProspectId?: string | null }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const activeMessageId = useRef(messageId);
  activeMessageId.current = messageId;
  const titleId = useId();
  const [data, setData] = useState<Data | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [confirmSharedAddress, setConfirmShared] = useState(false);
  const [detachAddress, setDetachAddress] = useState(false);
  const owner = data ? data.currentProspectId : currentProspectId;
  useEffect(() => { setData(null); setStatus(''); setBusy(false); setConfirmShared(false); setDetachAddress(false); dialog.current?.close(); }, [messageId]);
  async function load(q = '') {
    setBusy(true); setStatus('');
    try {
      const response = await fetch(`/api/email/messages/${messageId}/link${q ? `?q=${encodeURIComponent(q)}` : ''}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not load lead suggestions.');
      if (activeMessageId.current === messageId) setData(result.data);
    } catch (error) { if (activeMessageId.current === messageId) setStatus(error instanceof Error ? error.message : 'Request failed.'); }
    finally { if (activeMessageId.current === messageId) setBusy(false); }
  }
  async function decide(action: 'link' | 'unlink' | 'reject', prospectId?: string) {
    setBusy(true); setStatus('');
    try {
      const response = await fetch(`/api/email/messages/${messageId}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(prospectId ? { prospectId } : {}), ...(action === 'link' ? { confirmSharedAddress } : { detachAddress }) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'The association could not be changed.');
      // Read the exact target back before declaring success; no automatic link on open/search.
      const readback = await fetch(`/api/email/messages/${messageId}/link`, { cache: 'no-store' });
      const verified = await readback.json();
      if (!readback.ok || verified.data.currentProspectId !== (action === 'link' ? prospectId : null)) throw new Error('Change submitted; reload to verify ownership.');
      if (activeMessageId.current !== messageId) return;
      setData(verified.data); setStatus(action === 'link' ? 'Linked by founder. Nothing sent.' : 'Association removed; history and suppressions retained. Nothing sent.');
      router.refresh();
    } catch (error) { if (activeMessageId.current === messageId) setStatus(error instanceof Error ? error.message : 'Request failed.'); }
    finally { if (activeMessageId.current === messageId) setBusy(false); }
  }
  return <>
    <button type="button" className="btn-secondary btn-xs" onClick={() => { dialog.current?.showModal(); void load(); }}>{owner ? 'Review / unlink lead' : 'Link to lead'}</button>
    <dialog ref={dialog} aria-labelledby={titleId} className="m-auto rounded-xl border border-line bg-paper p-5 text-12 leading-5 text-ink backdrop:bg-ink/40" style={{ width: 'min(36rem, calc(100vw - 2rem))', maxHeight: '85vh', overflow: 'auto', overflowWrap: 'anywhere' }}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <h2 id={titleId} className="text-16 font-bold">Message lead association</h2>
        <button type="button" className="btn-secondary btn-xs" onClick={() => dialog.current?.close()}>Close</button>
      </div>
      <p>Suggestions are evidence to review, not automatic matches. Message-confirmed addresses are labelled “Linked by founder”, not published research.</p>
      <form className="my-3 min-w-0 space-y-2" onSubmit={e => { e.preventDefault(); void load(query); }}>
        <label className="block font-semibold">Search leads <input className="mt-1 block w-full min-w-0 rounded-lg border border-line bg-white px-3 py-2 font-normal" value={query} maxLength={100} onChange={e => setQuery(e.target.value)} /></label>
        <button className="btn-secondary btn-xs" type="submit" disabled={busy}>Search</button>
      </form>
      <label className="my-2 block"><input type="checkbox" checked={confirmSharedAddress} onChange={e => setConfirmShared(e.target.checked)} /> I explicitly confirm this address belongs to this lead even if it is a shared generic inbox.</label>
      <label className="my-2 block"><input type="checkbox" checked={detachAddress} onChange={e => setDetachAddress(e.target.checked)} /> Also detach the stored address association (retain evidence and all suppressions).</label>
      {owner && <div className="my-3 flex flex-wrap gap-2"><button className="btn-secondary btn-xs" disabled={busy} onClick={() => void decide('unlink', owner)}>Unlink message</button> <button className="btn-secondary btn-xs" disabled={busy} onClick={() => void decide('reject', owner)}>Not this lead</button></div>}
      {data && !data.eligible && <p>This message cannot establish an address: delivery reports, automatic replies and self messages are excluded.</p>}
      {[...(data?.suggestions ?? []), ...(data?.search ?? []).filter(p => !data?.suggestions.some(s => s.id === p.id))].map(p => <div key={p.id} className="my-3 rounded-lg border border-line bg-white/50 p-3">
        <strong>{p.businessName}</strong><p>{p.reason}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn-secondary btn-xs" disabled={busy || !data?.eligible || Boolean(owner && owner !== p.id)} onClick={() => void decide('link', p.id)}>Link</button>
          <button className="btn-secondary btn-xs" disabled={busy || Boolean(owner && owner !== p.id)} onClick={() => void decide('reject', p.id)}>Not this lead</button>
        </div>
      </div>)}
      <p role="status" aria-live="polite">{busy ? 'Working…' : status}</p>

    </dialog>
  </>;
}
