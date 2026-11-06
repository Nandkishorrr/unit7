// A place a site can go. Each host says what it takes and does one job: put these files or this repo live. Tools in
// src/tools/live.ts do the rest (what is it, is it safe to publish, which host), so adding a host is one small file.
import type { Ctx } from '../tools/runtime.ts';
import { all } from '../db.ts';
import type { Site } from './source.ts';

export interface Place { host: string; accountId?: string; serverId?: string; label: string }
export interface Fit { ok: boolean; why: string; best?: boolean }
export interface Put { name: string; site: Site; place: Place; env: { key: string; value: string; secret: boolean }[]; domain?: string; update: boolean; team?: string }
export interface Placed { url: string; project: string; deployment?: string; dashboard?: string; notes?: string[]; autoDeploy?: boolean }
export interface Ref { place: Place; project: string; deployment?: string }
export interface Host {
  id: string; name: string;
  // takes finished files as they are, or builds them there
  builds: boolean;
  places(ctx: Pick<Ctx, 'db' | 'orgId'>): Place[];
  fit(site: Site): Fit;
  put(ctx: Ctx, p: Put): Promise<Placed>;
  logs?(ctx: Ctx, r: Ref): Promise<string[]>;
  env?(ctx: Ctx, r: Ref, op: { set?: { key: string; value: string; secret: boolean }[]; unset?: string[] }): Promise<{ key: string }[]>;
}

export const accountsOf = (ctx: Pick<Ctx, 'db' | 'orgId'>, host: string, provider: string): Place[] =>
  all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM accounts WHERE org_id = ? AND provider = ? AND status != 'failing' ORDER BY name`, ctx.orgId, provider)
    .map((a) => ({ host, accountId: a.id, label: a.name }));

const hosts = new Map<string, Host>();
export const addHost = (h: Host) => { hosts.set(h.id, h); return h; };
export const allHosts = () => [...hosts.values()];
export const hostOf = (id: string) => hosts.get(id);
