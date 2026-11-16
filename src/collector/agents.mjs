// Turns live sessions and their subagents into AgentInfo records.
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_MODELS, modelKeyOf } from '../shared/models.mjs';
import { JsonlTail } from './tail.mjs';
import { TranscriptStats, withAgentType } from './transcript.mjs';
import { SessionReader, findTranscript, isSafeId } from './sessions.mjs';

/** How long a finished subagent stays listed (status 'done') so it can be seen leaving. */
export const DONE_LINGER_MS = 30_000;
const TRANSCRIPT_RETRY_MS = 2_000;
const SETTINGS_TTL_MS = 10_000;
const META_FILE = /^agent-(.+)\.meta\.json$/;

/** One line, at most `max` characters. */
export function clip(text, max = 80) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Changes whenever the file is rewritten; null when it cannot be read. */
function versionOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export class AgentTracker {
  /**
   * @param {{configDir:string, extraModels?:object[], isAlive?:(pid:number)=>boolean,
   *          excludeCwds?:Iterable<string>, excludePids?:()=>Iterable<number>,
   *          doneLingerMs?:number}} opts
   */
  constructor({ configDir, extraModels = [], isAlive, excludeCwds, excludePids, doneLingerMs = DONE_LINGER_MS }) {
    this.configDir = configDir;
    this.extraModels = extraModels;
    this.doneLingerMs = doneLingerMs;
    this.reader = new SessionReader({ configDir, isAlive, excludeCwds, excludePids });
    this.knownKeys = new Set([...extraModels, ...BUILTIN_MODELS].map((m) => m.key));
    this.sessions = new Map();   // sessionId -> session state
    this.settings = { at: -Infinity, model: null };
  }

  /**
   * Re-read whatever changed on disk and list the agents as of `now`.
   * @returns {import('../shared/contract.mjs').AgentInfo[]}
   */
  update(now) {
    const live = this.reader.read();
    const liveIds = new Set(live.map((s) => s.sessionId));
    // A session that is gone takes its subagents with it.
    for (const id of this.sessions.keys()) if (!liveIds.has(id)) this.sessions.delete(id);

    const agents = [];
    for (const session of live) {
      let state = this.sessions.get(session.sessionId);
      if (!state) {
        state = {
          firstSeenAt: now, transcript: null, tail: null, lookedAt: -Infinity,
          stats: new TranscriptStats({ main: true }),
          // ignored: agentId -> version of its meta file when it was set aside
          subs: new Map(), ignored: new Map(), baselined: false,
        };
        this.sessions.set(session.sessionId, state);
      }
      this.#readMain(session, state, now);
      this.#scanSubagents(session, state, now);
      agents.push(...this.#describe(session, state, now));
    }
    return agents;
  }

  #readMain(session, state, now) {
    if (state.tail && !state.tail.exists) {
      state.transcript = null;
      state.tail = null;
    }
    if (!state.transcript && now - state.lookedAt >= TRANSCRIPT_RETRY_MS) {
      state.lookedAt = now;
      state.transcript = findTranscript(this.configDir, session.sessionId, session.cwd);
      if (state.transcript) {
        state.tail = new JsonlTail(state.transcript);
        state.stats.reset();
      }
    }
    state.tail?.poll((line) => state.stats.consumeLine(line), () => state.stats.reset());
  }

  #scanSubagents(session, state, now) {
    if (!state.transcript) return;   // subagents live next to the transcript
    const dir = path.join(path.dirname(state.transcript), session.sessionId, 'subagents');
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const baseline = !state.baselined;
    const present = new Set();
    for (const name of names) {
      const agentId = META_FILE.exec(name)?.[1];
      if (!agentId || !isSafeId(agentId)) continue;
      present.add(agentId);

      // The meta file is only re-read when it was rewritten. That is also how an agent
      // that was set aside (finished, dropped) comes back: its meta loses `finished`.
      const metaFile = path.join(dir, name);
      const version = versionOf(metaFile);
      let sub = state.subs.get(agentId);
      const known = sub ? sub.metaVersion : state.ignored.get(agentId);
      if (version != null && version === known) continue;
      const meta = readJson(metaFile);
      if (!meta) continue;   // being written; look again next time

      if (!sub) {
        const setAside = state.ignored.has(agentId);
        // Finished before anyone was watching, or still finished since it was set aside.
        if (meta.finished === true && (baseline || setAside)) {
          state.ignored.set(agentId, version);
          continue;
        }
        state.ignored.delete(agentId);
        // A new tail reads the whole transcript, so its totals are complete.
        sub = {
          agentId, meta, metaVersion: version, firstSeenAt: now, finishedAt: null,
          tail: new JsonlTail(path.join(dir, `agent-${agentId}.jsonl`)),
          stats: new TranscriptStats(),
        };
        state.subs.set(agentId, sub);
      } else {
        sub.meta = meta;
        sub.metaVersion = version;
      }
      if (meta.finished === true) sub.finishedAt ??= now;
      else sub.finishedAt = null;   // running, or resumed while clocking out
    }
    state.baselined = true;

    for (const [agentId, sub] of state.subs) {
      if (!present.has(agentId) || (sub.finishedAt != null && now - sub.finishedAt >= this.doneLingerMs)) {
        state.subs.delete(agentId);
        if (present.has(agentId)) state.ignored.set(agentId, sub.metaVersion);
        continue;
      }
      sub.tail.poll((line) => sub.stats.consumeLine(line), () => sub.stats.reset());
      // Left unfinished by an earlier run of this session (crash, kill): its last entry
      // predates the process that owns the session now, so nothing is running it.
      if (baseline && sub.finishedAt == null && sub.stats.lastTs != null
        && session.startedAt != null && sub.stats.lastTs < session.startedAt) {
        state.subs.delete(agentId);
        state.ignored.set(agentId, sub.metaVersion);
      }
    }
  }

  #describe(session, state, now) {
    const { stats } = state;
    const project = session.cwd ? path.basename(session.cwd) || null : null;
    const mainModel = stats.model ?? stats.requestedModel ?? this.#defaultModel(now) ?? '';
    const waiting = session.status !== 'busy';
    const startedAt = session.startedAt ?? stats.firstTs ?? state.firstSeenAt;
    const main = {
      id: session.sessionId,
      sessionId: session.sessionId,
      parentId: null,
      kind: 'main',
      name: clip(session.name) ?? clip(stats.title) ?? project ?? 'session',
      agentType: null,
      project,
      model: mainModel,
      modelKey: this.#keyOf(mainModel),
      status: waiting ? 'waiting' : 'working',
      activity: waiting ? 'idle' : stats.activity ?? 'think',
      tool: stats.tool,
      task: clip(stats.title),
      startedAt,
      lastActiveAt: Math.max(startedAt, stats.lastTs ?? 0, session.statusUpdatedAt ?? 0),
      finishedAt: null,
      tokens: { ...stats.tokens },
      rate: stats.rate(now),
    };

    // Which agent made the tool call that spawned each subagent (nested agents).
    const spawner = new Map();
    for (const sub of state.subs.values()) {
      for (const toolUseId of sub.stats.spawned) spawner.set(toolUseId, `${session.sessionId}:${sub.agentId}`);
    }

    const subs = [];
    for (const sub of state.subs.values()) {
      const { meta, stats: s } = sub;
      const id = `${session.sessionId}:${sub.agentId}`;
      const agentType = typeof meta.agentType === 'string' && meta.agentType ? meta.agentType : null;
      const model = s.model ?? s.requestedModel ?? this.#alias(meta.model) ?? mainModel;
      const done = sub.finishedAt != null;
      const subStarted = s.firstTs ?? sub.firstSeenAt;
      const parent = spawner.get(meta.toolUseId);
      subs.push({
        id,
        sessionId: session.sessionId,
        parentId: parent && parent !== id ? parent : main.id,
        kind: 'sub',
        name: clip(meta.description) ?? agentType ?? sub.agentId,
        agentType,
        project,
        model,
        modelKey: this.#keyOf(model),
        status: done ? 'done' : 'working',
        activity: done ? 'idle' : withAgentType(s.activity ?? 'think', agentType),
        tool: s.tool,
        task: clip(meta.description),
        startedAt: subStarted,
        lastActiveAt: Math.max(subStarted, s.lastTs ?? 0),
        finishedAt: sub.finishedAt,
        tokens: { ...s.tokens },
        rate: s.rate(now),
      });
    }
    subs.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
    return [main, ...subs];
  }

  #keyOf(model) {
    return model ? modelKeyOf(model, this.extraModels) : 'unknown';
  }

  /** A model alias ('haiku', 'opus[1m]') is only trusted when it names a machine we know. */
  #alias(alias) {
    if (typeof alias !== 'string' || !alias.trim()) return null;
    return this.knownKeys.has(modelKeyOf(alias, this.extraModels)) ? alias.trim() : null;
  }

  /** The user's default model, for a session that has not made a request yet. */
  #defaultModel(now) {
    if (now - this.settings.at >= SETTINGS_TTL_MS || now < this.settings.at) {
      const settings = readJson(path.join(this.configDir, 'settings.json'));
      this.settings = { at: now, model: this.#alias(settings?.model) };
    }
    return this.settings.model;
  }
}
