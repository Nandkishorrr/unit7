// Rules in your own words. They bind every AI and Warden at the gate, not as a note an AI might ignore.
import { useState } from 'react';
import { useTool } from '../care/data';
import { act, Button, Card, Input } from '../../ui';

export function RulesCard() {
  const { data, reload } = useTool<{ rules: { id: string; text: string; by: string }[] }>('rule.list', {});
  const [text, setText] = useState('');
  const add = async (e: React.FormEvent) => { e.preventDefault(); if (await act('rule.add', { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, { success: 'Rule added', undo: false })) { setText(''); reload(); } };
  return (
    <Card className="mt-4 p-5">
      <h2 className="text-[15px] font-semibold tracking-[-0.015em]">Your rules</h2>
      <p className="text-[13px] text-muted">In your own words. No AI and no automatic step can break them. You still can, and copies still run.</p>
      {!!data?.rules.length && <ul className="mt-2 divide-y divide-line">{data.rules.map((r) => <li key={r.id} className="flex items-center gap-3 py-2 text-[13.5px] text-ink"><span className="min-w-0 flex-1">{r.text}</span><Button size="sm" variant="ghost" onClick={async () => { await act('rule.remove', { id: r.id }, { success: 'Removed', undo: false }); reload(); }}>Remove</Button></li>)}</ul>}
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={add}><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Never touch the shop during work hours" aria-label="A new rule" className="min-w-0 flex-1 basis-[260px]" /><Button type="submit" variant="secondary" disabled={text.trim().length < 5}>Add rule</Button></form>
    </Card>
  );
}
