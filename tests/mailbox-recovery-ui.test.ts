import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const thread = source('components/conversation-message.tsx');
const link = source('components/message-link-actions.tsx');
const recipient = source('components/lead-reply-recipient.tsx');
const standalone = source('app/(app)/email/[id]/page.tsx');
const inbox = source('app/(app)/email/folder-inbox.tsx');
const tools = source('app/(app)/email/email-tools.tsx');
const lead = source('app/(app)/leads/[id]/page.tsx');

describe('mailbox recovery UI wiring (source-only; no data, model or sends)', () => {
  it.each([['standalone', standalone], ['folder inbox', inbox]])('passes actual address and real-reply facts through %s', (_name, page) => {
    expect(page).toContain('addressLinkStatus={message.addressLinkStatus}');
    expect(page).toContain('isProspectReply={message.isProspectReply}');
    expect(page).toMatch(/currentProspectId=\{(?:conversation\.prospect\.id|selected\.prospectId)\}/);
    expect(page).toContain('message.direction === "inbound" && message.isProspectReply !== false');
    expect(page.indexOf('<LeadReplyRecipient')).toBeLessThan(page.indexOf('<ReplyComposer'));
    expect(page).not.toContain('autoSuggest=');
  });

  it('labels only true address associations linked and excludes reports from thread controls', () => {
    expect(thread).toContain('inbound && props.isProspectReply !== false');
    expect(thread).toContain('props.addressLinkStatus === true && <p>Replied from a new address: {fromEmail} — linked');
    expect(thread).toContain('props.addressLinkStatus === false && <p>Thread matched; address not linked');
    expect(thread).toContain('currentProspectId={props.currentProspectId}');
  });

  it('gives every rendered unmatched message a link control without an eligibility filter', () => {
    const unmatched = tools.slice(tools.indexOf('{unknown.map'), tools.indexOf('{active === "Sent"'));
    expect(unmatched).toContain('<MessageLinkActions messageId={message.id} />');
    expect(unmatched).not.toContain('isProspectReply');
    expect(link).toContain("'Link to lead'");
    expect(link).toContain('delivery reports, automatic replies and self messages are excluded');
  });

  it('keeps mount/search read-only and writes behind explicit decisions with exact readback', () => {
    const load = link.slice(link.indexOf('async function load'), link.indexOf('async function decide'));
    expect(load).not.toContain('POST');
    expect(link.slice(link.indexOf('useEffect(()'), link.indexOf('async function load'))).not.toContain('decide(');
    expect(link).toContain('verified.data.currentProspectId');
    const mount = recipient.slice(recipient.indexOf('useEffect(()'), recipient.indexOf('async function save'));
    expect(mount).toContain("fetch(url, { cache: 'no-store' })");
    expect(mount).not.toContain('POST');
    expect(recipient).toContain('verified.data.preferredEmailId');
  });

  it('uses bounded, wrapping design-system controls and a visible accessible Close', () => {
    expect(link).not.toContain('className="button secondary"');
    expect(link).toContain('btn-secondary btn-xs');
    expect(link).toContain("maxHeight: '85vh'");
    expect(link).toContain('aria-labelledby={titleId}');
    expect(link).toMatch(/<button type="button" className="btn-secondary btn-xs" onClick=\{\(\) => dialog.current\?\.close\(\)\}>Close/);
    expect(link).toContain('className="my-2 block"');
    expect(link).toContain('w-full min-w-0');
    expect(recipient).toContain('w-full min-w-0 max-w-full truncate');
    expect(recipient).toContain('First contacted');
    expect(recipient).toContain('Now writing from (stored address)');
    expect(recipient).toContain('Association removed; evidence retained');
  });

  it('retains primary contact, lists address-specific failures and separates suppressed soft failures', () => {
    expect(lead).toContain('getAddressDeliveryStatuses(prospect.id)');
    expect(lead).toContain('addressStatuses.map');
    expect(lead).toContain('bounced, permanent');
    expect(lead).toContain('"transient_suppressed" ? "temporary, suppressed (retry limit reached)"');
    expect(lead).toContain('"transient_retrying" ? "temporary, retrying"');
    expect(lead).toContain('formatDate(address.occurredAt, undefined, settings.timezone)');
    expect(lead).toContain('{prospect.contactEmail}');
    expect(lead).toContain('<LeadReplyRecipient prospectId={prospect.id} />');
    expect(lead.indexOf('<LeadReplyRecipient')).toBeLessThan(lead.indexOf('<DraftEditor'));
  });
});
