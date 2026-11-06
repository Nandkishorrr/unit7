// One error type with a stable code. `message` is written for the person reading it — the agent
// relays it as-is — so say what happened and what to do, never "ERROR 500".
export class Unit7Error extends Error {
  code: string;
  status: number;
  detail?: unknown;
  constructor(code: string, message: string, status = 400, detail?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export const notFound = (what: string) => new Unit7Error('not_found', `${what} was not found.`, 404);
export const forbidden = (why: string) => new Unit7Error('forbidden', why, 403);
