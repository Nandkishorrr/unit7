import { z } from 'zod';
import type { Ctx } from './runtime.ts';
import { forbidden, Unit7Error } from '../errors.ts';
import { type Role } from '../policy.ts';
import { get } from '../db.ts';

export const isAgent = (ctx: Pick<Ctx, 'actor'>) => ctx.actor.kind === 'agent' || ctx.actor.role === 'agent';

// real values go to a person who may work on things; an AI, a key and a read-only seat get the masked view
export const seesReal = (ctx: Ctx) => ctx.actor.kind === 'user' && ['owner', 'admin', 'developer'].includes(ctx.actor.role);

export function requireHuman(ctx: Ctx, what: string) {
  if (isAgent(ctx)) throw forbidden(`Only a person can ${what}. Agents work with references, never raw values.`);
}
export function requireRole(ctx: Ctx, roles: Role[], what: string) {
  if (!roles.includes(ctx.actor.role)) throw forbidden(`Your role (${ctx.actor.role}) cannot ${what}.`);
}

export const name = z.string().trim().min(1).max(80);
export const fid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{12}$`), `must be a ${prefix}_ id`);

export function uniqueSlug(ctx: Ctx, sql: string, base: string, ...scope: string[]) {
  const s = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
  if (get(ctx.db, sql, ...scope, s)) throw new Unit7Error('exists', `Something called "${s}" already exists here. Pick another name.`, 409);
  return s;
}
