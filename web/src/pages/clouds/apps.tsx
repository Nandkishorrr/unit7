// Redeploy, restart and roll back an app on the big clouds (Cloud Run, App Engine, Firebase Hosting, Amplify, EC2,
// Lightsail, Azure App Service) and on Vercel, Netlify and Render, as small buttons for the Map's and Overview's pop-ups. Only what the platform can do is
// shown; each says what happens first, and goes through the gate (an AI asks first for anything but a restart).
import { useEffect, useState } from 'react';
import { History, RefreshCw, RotateCcw } from 'lucide-react';
import { runTool } from '../../lib/api';
import { act, Button, confirmDialog, toast } from '../../ui';
import { verifiedOf } from '../../lib/alertActions';

type Mode = 'redeploy' | 'restart' | 'rollback';
interface Can { name: string; where: string; modes: Mode[]; why?: string; impact: Partial<Record<Mode, string>> }
const CLOUD = new Set(['vercel', 'netlify', 'render', 'cloudrun', 'appengine', 'firebase', 'amplify', 'ec2', 'lightsail', 'azure']);
const LABEL: Record<Mode, string> = { redeploy: 'Redeploy', restart: 'Restart', rollback: 'Roll back' };
const ICON: Record<Mode, typeof RefreshCw> = { redeploy: RefreshCw, restart: RotateCcw, rollback: History };
const DONE: Record<Mode, string> = { redeploy: 'Redeployed', restart: 'Restarting', rollback: 'Rolled back' };
const SWAP_IN_ONE_STEP = new Set(['vercel', 'netlify', 'render']);

// asset: a map item (its id ast_… and provider). Renders nothing for things that aren't on a big cloud.
export function CloudAppActions({ asset, size = 'sm', onDone }: { asset: { id: string; provider: string; name?: string }; size?: 'sm' | 'md'; onDone?: () => void }) {
  const [can, setCan] = useState<Can | null>(null);
  const [busy, setBusy] = useState<Mode | null>(null);
  useEffect(() => {
    if (!CLOUD.has(asset.provider)) return;
    let live = true;
    runTool('cloud.app_actions', { asset: asset.id }).then((r) => { if (live && r.status === 'ok') setCan(r.output as Can); }, () => undefined);
    return () => { live = false; };
  }, [asset.id, asset.provider]);
  // Z8: these hosts start the new version, then move visitors in one step (nothing to set up for zero downtime)
  const oneStep = SWAP_IN_ONE_STEP.has(asset.provider) ? <p className="basis-full text-[12.5px] text-muted sm:text-right">This host swaps versions in one step: no downtime during deploys.</p> : null;
  if (!can) return oneStep;
  if (!can.modes.length) return can.why ? <p className="text-[12.5px] text-muted">{can.why}</p> : oneStep;
  const go = async (m: Mode) => {
    if (!(await confirmDialog({ title: `${LABEL[m]} ${can.name}?`, body: can.impact[m], confirm: LABEL[m], danger: m === 'rollback' }))) return;
    setBusy(m);
    const r = await act('cloud.redeploy', { asset: asset.id, mode: m }, { success: `${DONE[m]}: ${can.name}` });
    setBusy(null);
    // the live address was checked afterwards: say so when it isn't answering
    const v = verifiedOf(r?.output);
    if (v && !v.fixed) toast('warn', `${can.name} isn’t answering yet`, v.still);
    if (r) onDone?.();
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${can.name} on ${can.where}`}>
        {can.modes.map((m) => { const I = ICON[m]; return <Button key={m} size={size} variant={m === 'rollback' ? 'ghost' : 'soft'} icon={<I size={13} />} loading={busy === m} disabled={!!busy} onClick={() => go(m)}>{LABEL[m]}</Button>; })}
      </div>
      {oneStep}
    </>
  );
}
