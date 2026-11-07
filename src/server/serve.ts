import { serve as listen } from '@hono/node-server';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { createApp } from '../app.ts';
import { createHttp } from './http.ts';
import '../tools/index.ts';
import { drainTools } from '../tools/runtime.ts';
import { redact } from '../redact.ts';

export interface ServeOptions { port: number; host: string; tlsCert?: string; tlsKey?: string }

export async function serve(o: ServeOptions) {
  // a background promise nobody caught is a bug to log, not a reason to take every app's watchdog down
  process.on('unhandledRejection', (e) => console.error('Unhandled rejection (Unit7 keeps running):', redact(String((e as Error)?.stack ?? e))));
  const app = createApp();
  app.services.listen = { host: o.host, port: o.port };
  app.vault.purgeRetired();
  setInterval(() => app.vault.purgeRetired(), 24 * 3600_000).unref();
  const http = createHttp(app);
  const { warden } = await import('../sentinel/warden.ts');
  warden(app).start();
  const { refreshClaudeCommand } = await import('../agents/clients.ts');
  refreshClaudeCommand(); // an installed /unit7 command learns new tricks (like /unit7 watch) on upgrade
  const { startNotifier } = await import('../sentinel/notify.ts');
  startNotifier(app); // phone / Slack / Discord alerts for what needs a person
  const { startPhoneApprovals } = await import('../sentinel/phone.ts');
  startPhoneApprovals(app); // Approve / Reject from the phone alert, over outgoing connections only
  const { startCare } = await import('../care/phonefix.ts');
  startCare(app); // "Let Unit7 fix it" from a phone alert: follows the fix through to "Fixed" or "Didn't work"
  const { startUptimeWatch } = await import('../tools/uptime.ts');
  startUptimeWatch(app); // a site that goes live is added to the Uptime Kuma Unit7 has a login for
  const { startRecheck } = await import('../tools/recheck.ts');
  startRecheck(app); // after a change, the alerts about what it touched are checked again at once (not at the next sync)
  const tls = o.tlsCert && o.tlsKey ? { cert: readFileSync(o.tlsCert), key: readFileSync(o.tlsKey) } : undefined;
  const server = listen({
    fetch: http.fetch, port: o.port, hostname: o.host,
    ...(tls && { createServer: createHttps, serverOptions: tls }),
  }, (info) => {
    // Browsers try "localhost" as ::1 first. If Unit7 only held 127.0.0.1, any other program could take [::1] on the
    // same port and receive the passwords, cookies and tokens meant for Unit7. So Unit7 holds both, or says so.
    if (o.host === '127.0.0.1') {
      listen({ fetch: http.fetch, port: info.port, hostname: '::1', ...(tls && { createServer: createHttps, serverOptions: tls }) })
        .on('error', (e: NodeJS.ErrnoException) => console.warn(e.code === 'EADDRINUSE'
          ? `Warning: another program is listening on [::1]:${info.port}. Open Unit7 at http://127.0.0.1:${info.port}, not localhost, until it's gone.`
          : `Note: no IPv6 loopback (${e.code}); open Unit7 at http://127.0.0.1:${info.port}.`));
    }
    const url = process.env.UNIT7_URL ?? `${tls ? 'https' : 'http'}://${o.host === '0.0.0.0' ? 'localhost' : o.host}:${info.port}`;
    console.log(`Unit7 is running at ${url}`);
    if (!tls && o.host !== '127.0.0.1' && o.host !== 'localhost') {
      console.warn('Warning: listening beyond localhost without TLS. Put Unit7 behind HTTPS (Caddy) or pass --tls-cert/--tls-key.');
    }
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1); // asked twice: now
    stopping = true;
    console.log('Unit7 is shutting down…');
    server.close();
    (app.services.warden as { stop?: () => void })?.stop?.();
    await drainTools(7000); // with the 2 seconds it adds, inside the 10 that docker stop gives before it kills
    (app.services.ssh as { closeAll?: () => void })?.closeAll?.();
    (app.services.hostinger as { closeAll?: () => void })?.closeAll?.();
    app.db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { app, server };
}
