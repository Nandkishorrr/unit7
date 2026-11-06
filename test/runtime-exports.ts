// the runtime with every tool registered, for tests that look across all of them
import '../src/tools/index.ts';
export { decideApproval, getTool, tools as allTools } from '../src/tools/runtime.ts';
