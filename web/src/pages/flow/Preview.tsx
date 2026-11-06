// Dev-only harness: "Save as a routine" under a chat, as the Home thread would mount it, for your newest chat with
// finished steps. Not in the app's routes or build; open /src/pages/flow/preview.html on the Vite dev server while
// signed in. ?theme=dark.
import '../../styles.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, startLive } from '../../lib/api';
import { Toaster } from '../../ui';
import { SaveAsRoutine, canSaveSteps } from './Routines';
import type { ChatMsg } from '../chat/types';

document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') === 'dark');
function App() {
  const [chat, setChat] = useState<{ id: string; title: string; messages: ChatMsg[] } | null>(null);
  useEffect(() => {
    startLive();
    void api<{ id: string; title: string }[]>('/api/agent/conversations').then(async (list) => {
      for (const c of list) {
        const { messages } = await api<{ messages: ChatMsg[] }>(`/api/agent/conversations/${c.id}`);
        if (canSaveSteps(messages)) return setChat({ ...c, messages });
      }
    });
  }, []);
  if (!chat) return <p className="p-8 text-muted">Looking for a chat with finished steps…</p>;
  return (
    <div className="mx-auto max-w-[760px] space-y-3 p-8">
      <p className="text-[13px] text-muted">{chat.title}</p>
      <div className="rounded-[18px] bg-surface p-4 text-[14px] shadow-soft">{(chat.messages.findLast((m) => m.role === 'assistant')?.content as { text?: string })?.text}</div>
      <SaveAsRoutine conversationId={chat.id} messages={chat.messages} />
      <Toaster />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
