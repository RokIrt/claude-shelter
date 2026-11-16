// What one agent's transcript says about it: tokens, model, latest activity. Pure
// (fed line by line), so it works the same for a main session and a subagent.
import { zeroTokens, zeroRate } from '../shared/models.mjs';

export const RATE_WINDOW_MS = 60_000;
const SYNTHETIC = '<synthetic>';

// Transcripts carry huge lines (request blobs, tool results). Only these entry types
// matter, so everything else is skipped before paying for JSON.parse.
const RELEVANT = /"type"\s*:\s*"(?:assistant|ai-title|api-request)"/;

const TOOL_ACTIVITY = new Map(Object.entries({
  Edit: 'code', Write: 'code', NotebookEdit: 'code', MultiEdit: 'code',
  Bash: 'shell', BashOutput: 'shell', KillShell: 'shell',
  Read: 'research', Grep: 'research', Glob: 'research', ToolSearch: 'research', LS: 'research',
  WebFetch: 'web', WebSearch: 'web', web_search: 'web', web_fetch: 'web',
  Agent: 'delegate', Task: 'delegate', SendMessage: 'delegate', Workflow: 'delegate',
  EnterPlanMode: 'plan', ExitPlanMode: 'plan', TodoWrite: 'plan', AskUserQuestion: 'plan',
}));

/** Tools that start another agent; their tool_use ids link a subagent to its spawner. */
const SPAWN_TOOLS = new Set(['Agent', 'Task', 'Workflow']);

/**
 * Activity for a tool name. Tools the shelter has no station for (Skill, MCP tools,
 * hand-back calls, ...) count as 'think'.
 * @returns {import('../shared/contract.mjs').Activity}
 */
export function activityForTool(name) {
  return TOOL_ACTIVITY.get(name) ?? 'think';
}

/** A reviewer agent is shown reviewing whenever it would otherwise be coding, reading or thinking. */
export function withAgentType(activity, agentType) {
  if (typeof agentType === 'string' && /review/i.test(agentType)
    && (activity === 'code' || activity === 'research' || activity === 'think')) return 'review';
  return activity;
}

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export class TranscriptStats {
  /** @param {{main?:boolean}} [opts] main: skip sidechain entries (they belong to subagents) */
  constructor(opts = {}) {
    this.main = !!opts.main;
    this.reset();
  }

  reset() {
    this.tokens = zeroTokens();
    /** message.id -> its usage as last seen; one API message is written as several lines */
    this.byId = new Map();
    this.recent = [];             // usage records that may still be inside the rate window
    this.model = null;            // model of the latest assistant message
    this.requestedModel = null;   // model of the latest API request (known before any reply)
    this.tool = null;             // most recent tool name
    this.activity = null;         // from the most recent assistant content block
    this.title = null;            // latest ai-title
    this.firstTs = null;
    this.lastTs = null;
    this.spawned = new Set();     // tool_use ids of agent-spawning calls made by this agent
  }

  /** Feed one raw JSONL line. Malformed and irrelevant lines are ignored. */
  consumeLine(line) {
    if (!RELEVANT.test(line)) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!entry || typeof entry !== 'object') return;

    if (entry.type === 'ai-title') {
      if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) this.title = entry.aiTitle.trim();
      return;
    }
    if (entry.type === 'api-request') {
      const model = entry.params?.model;
      if (typeof model === 'string' && model && model !== SYNTHETIC) this.requestedModel = model;
      this.#stamp(Date.parse(entry.timestamp));
      return;
    }
    if (entry.type !== 'assistant') return;
    if (this.main && entry.isSidechain === true) return;
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.model !== 'string' || !msg.model || msg.model === SYNTHETIC) return;

    const ts = Date.parse(entry.timestamp);
    this.#stamp(ts);
    this.model = msg.model;

    const u = msg.usage;
    if (u && typeof u === 'object') {
      // Lines of one message repeat the same usage: count it once per message id, and
      // let a later line win in case an earlier one was written with partial numbers.
      const id = typeof msg.id === 'string' && msg.id ? msg.id : `line:${entry.uuid ?? this.byId.size}`;
      let rec = this.byId.get(id);
      if (!rec) {
        rec = { ts: Number.isFinite(ts) ? ts : this.lastTs ?? 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        this.byId.set(id, rec);
        this.recent.push(rec);
      }
      const next = {
        input: count(u.input_tokens),
        output: count(u.output_tokens),
        cacheRead: count(u.cache_read_input_tokens),
        cacheWrite: count(u.cache_creation_input_tokens),
      };
      for (const k of Object.keys(next)) {
        this.tokens[k] += next[k] - rec[k];
        rec[k] = next[k];
      }
    }

    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        if (typeof block.name !== 'string' || !block.name) continue;
        this.tool = block.name;
        this.activity = activityForTool(block.name);
        if (SPAWN_TOOLS.has(block.name) && typeof block.id === 'string') this.spawned.add(block.id);
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'text') {
        this.activity = 'think';
      }
    }
  }

  #stamp(ts) {
    if (!Number.isFinite(ts)) return;
    if (this.firstTs == null || ts < this.firstTs) this.firstTs = ts;
    if (this.lastTs == null || ts > this.lastTs) this.lastTs = ts;
  }

  /** Tokens per minute over the trailing minute, by each message's timestamp. */
  rate(now) {
    const from = now - RATE_WINDOW_MS;
    this.recent = this.recent.filter((r) => r.ts > from);
    const rate = zeroRate();
    const perMinute = 60_000 / RATE_WINDOW_MS;
    for (const r of this.recent) {
      if (r.ts > now) continue;
      rate.input += r.input * perMinute;
      rate.output += r.output * perMinute;
      rate.cacheRead += r.cacheRead * perMinute;
    }
    return rate;
  }
}
