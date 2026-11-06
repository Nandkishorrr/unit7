// The shapes the Home chat thread is made of. The server emits these as `agent.message` events and stores them
// per conversation; the web renders each by role. Three parts plug in here:
//   cards.tsx  — a live card for a tool step's result (domains, apps, servers, deploys…)
//   asks.tsx   — the interactive pickers the AI shows instead of asking in text (choose / confirm / form)
//   the thread — web/src/pages/Agent.tsx + Home.tsx: layout, streaming, and dispatch by role

export type StepStatus = 'running' | 'ok' | 'approval_required' | 'denied' | 'error';

// role 'tool': one Unit7 tool call made by the AI, updated in place (same id) as it runs
export interface ToolStep {
  tool: string;            // Unit7 tool name, e.g. 'domain.list', 'map.get', 'deployment.create'
  title?: string;          // the tool's plain title
  input?: any;
  status: StepStatus;
  output?: any;            // the tool's output when status is 'ok'
  error?: string;
  detail?: string;         // a failed step's log, kept apart from its plain error (Show details)
  why?: string;            // why an approval is needed
  approvalId?: string;
  approvalState?: 'pending' | 'approved' | 'rejected';
  durationMs?: number;
  code?: string;           // a failed step's error code (no_account, no_server…): its choices and "Set it up" come from it
}

// role 'ask': the AI asked the person something; the AI's run waits until it's answered (or expires)
export type AskSource = 'domains' | 'apps' | 'servers' | 'projects' | 'databases' | 'accounts';
// detail/logo come from the AI; provider…state come with live data for a source (GET /api/agent/asks/:id/options)
// recommended/why: the one the AI recommends and why, in a few words (ui.choose; shown as the strong button)
export interface ChoiceOption { id: string; label: string; detail?: string; logo?: string; recommended?: boolean; why?: string;
  provider?: string; sub?: string; url?: string; count?: number; state?: { tone: 'ok' | 'warn' | 'bad' | 'idle'; text: string } }
export type AskSpec =
  | { kind: 'choose'; title: string; note?: string; source?: AskSource; filter?: Record<string, string>; options?: ChoiceOption[];
      multiple?: boolean; allowNew?: { label: string; hint?: string }; preselect?: string }
  | { kind: 'confirm'; title: string; note?: string; changes: { label: string; before?: string; after: string }[]; undo?: string;
      danger?: boolean; confirmLabel?: string }
  | { kind: 'form'; title: string; note?: string; fields: { id: string; label: string; type: 'text' | 'secret' | 'select' | 'number';
      placeholder?: string; options?: string[]; required?: boolean; initial?: string }[]; submitLabel?: string }
  // ui.hide: the AI never hides anything; the person presses Hide it (snooze.set as them). what: Unit7's own words for it
  | { kind: 'hide'; title: string; note?: string; key: string; what: string; severity?: string; itemKind: string; for: 'tomorrow' | '7d' | '15d' | 'forever' }
  // ui.delete: the AI never deletes; the person's click runs the guided delete (or archive, or stop). live: production runs
  | { kind: 'delete'; title: string; note?: string; key: string; name: string; itemKind: string; provider: string; live: boolean; can: boolean; recommend: 'archive' | 'delete'; stops: number };
export type AskAnswer =
  | { choice: string[]; labels: string[]; items?: Record<string, unknown>[] } // choose (one or more ids; items: what the AI uses next, for a source)
  | { new: true }                                     // choose → the "add new" option
  | { ok: boolean }                                   // confirm
  | { values: Record<string, string> }                // form (secret fields come back as credential references, never values)
  | { cancelled: true }
  | { done: true }                                    // hide: the card hid it (the server checks the store)
  | { hidden: boolean; until?: string | null; forGood?: boolean } // hide, as the server recorded it
  | { outcome: 'deleted' | 'archived' | 'stopped' };   // delete: what the person did from the card (the server checks it)
export interface Ask { askId: string; spec: AskSpec; state: 'waiting' | 'answered' | 'expired' | 'cancelled'; answer?: AskAnswer; expiresAt?: string }

export type ChatMsg =
  | { id: string; role: 'user'; content: { text: string; context?: { kind: 'server' | 'project' | 'app' | 'domain' | 'database' | 'account' | 'environment'; id: string; name: string }[] }; created_at: string } // context: what it's about (the @ chips)
  | { id: string; role: 'assistant'; content: { text: string; final?: boolean; next?: string[] }; created_at: string } // next: the replies the AI suggests the person types next (server-cleaned, untrusted)
  | { id: string; role: 'tool'; content: ToolStep; created_at: string }
  | { id: string; role: 'status'; content: { tone: 'ok' | 'warn' | 'bad' | 'info'; text: string; code?: string }; created_at: string }
  | { id: string; role: 'ask'; content: Ask; created_at: string };
