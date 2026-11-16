// The data contract of Token Shelter. Pure documentation + constants; no logic.
//
//   collector (Node, reads ~/.claude)  ──►  Snapshot  ──►  derive()  ──►  ShelterState
//   scenarios (simulation fixtures)    ──►  Snapshot  ──┘                    │
//                                                        diffStates(prev, next) ──► ShelterEvent[]
//
// A Snapshot is raw facts. ShelterState is what the shelter shows (heat, statuses,
// forecasts, who stands where). Renderers (canvas world, DOM HUD, terminal) only
// ever read ShelterState and ShelterEvents.

export const SNAPSHOT_VERSION = 1;

/** Allowance levels, by percent used (and by forecast, see derive). */
export const WARN_PCT = 80;       // "approaching a limit"
export const CRITICAL_PCT = 92;
export const EXHAUSTED_PCT = 100;

/**
 * @typedef {{input:number, output:number, cacheRead:number, cacheWrite:number}} TokenCounts
 *   Cumulative raw token totals. Telemetry only: never converted into allowance.
 * @typedef {{input:number, output:number, cacheRead:number}} TokenRate   tokens per minute, recent
 */

/**
 * One allowance window as the plan reports it. Percentages are the plan's own numbers.
 * @typedef {Object} LimitRow
 * @property {string} id                 'session' | 'weekly' | 'model:<modelKey>'
 * @property {'session'|'weekly'|'model'} scope
 * @property {string|null} modelKey      set when scope is 'model'
 * @property {string} label              e.g. 'Session', 'Weekly (all models)', 'Fable weekly'
 * @property {number} percent            0..100 (may exceed 100)
 * @property {number|null} resetsAt      epoch ms
 * @property {number|null} ratePctPerHour  burn rate estimated from stored samples;
 *                                         null = not enough history yet
 * @property {string|null} severity      raw value from the plan ('normal', ...), informational
 * @property {boolean|null} active       raw is_active from the plan, informational
 */

/**
 * @typedef {Object} Limits
 * @property {number|null} at            epoch ms of the last successful reading; null = never
 * @property {boolean} stale             true when the last reading failed or is old
 * @property {string|null} error         last error message, if any
 * @property {LimitRow[]} rows
 * @property {{enabled:boolean, utilization:number|null, usedCredits:number|null,
 *             monthlyLimit:number|null, currency:string|null}|null} extra
 *   Extra-usage credits (the backup generator). utilization is 0..100. null = unknown.
 */

/**
 * @typedef {'code'|'shell'|'research'|'web'|'review'|'plan'|'delegate'|'think'|'idle'} Activity
 */

/**
 * One running (or just finished) agent.
 * @typedef {Object} AgentInfo
 * @property {string} id                 main agent: its sessionId; subagent: `${sessionId}:${agentId}`
 * @property {string} sessionId
 * @property {string|null} parentId      id of the agent that spawned it; null for a main agent
 * @property {'main'|'sub'} kind
 * @property {string} name               short display name (session name, or the subagent's description)
 * @property {string|null} agentType     e.g. 'general-purpose', 'Explore'; null for main agents
 * @property {string|null} project       basename of the working directory
 * @property {string} model              raw model id, e.g. 'claude-fable-5-2'
 * @property {string} modelKey           key into Snapshot.models, e.g. 'fable'
 * @property {'working'|'waiting'|'done'} status
 *   working: producing output or running tools; waiting: idle, waiting for input;
 *   done: finished (kept in the snapshot briefly so it can be seen clocking out)
 * @property {Activity} activity
 * @property {string|null} tool          most recent tool name
 * @property {string|null} task          one-line description of what it is doing (<= 80 chars)
 * @property {number} startedAt          epoch ms
 * @property {number} lastActiveAt       epoch ms
 * @property {number|null} finishedAt    epoch ms, when status is 'done'
 * @property {TokenCounts} tokens        cumulative for this agent
 * @property {TokenRate} rate
 */

/**
 * One tracked model = one machine in the shelter.
 * @typedef {Object} ModelInfo
 * @property {string} key                'fable' | 'opus' | 'sonnet' | 'haiku' | other
 * @property {string} label              'Fable'
 * @property {'fable'|'opus'|'sonnet'|'haiku'|'generic'} design
 * @property {{accent:number, accent2:number, variant:number}} style   palette indices + shape
 *                                       variant for the generic design (ignored by the others)
 * @property {TokenCounts} tokens        cumulative (all agents on this model)
 * @property {TokenRate} rate
 * @property {number} activeAgents       agents currently working on it
 */

/**
 * @typedef {Object} Snapshot
 * @property {1} v
 * @property {number} at                 epoch ms
 * @property {'live'|'simulation'} source
 * @property {string|null} scenario      simulation scenario name, else null
 * @property {Limits} limits
 * @property {AgentInfo[]} agents
 * @property {ModelInfo[]} models        every model that has a machine, in display order
 */

// ───────────────────────────── derived state ─────────────────────────────

/**
 * An allowance window with its forecast.
 * @typedef {Object} LimitView
 * @property {string} id
 * @property {'session'|'weekly'|'model'} scope
 * @property {string|null} modelKey
 * @property {string} label
 * @property {number} percent
 * @property {number|null} resetsAt
 * @property {number|null} resetInMs       time until the reset (>= 0)
 * @property {number|null} ratePctPerHour  burn rate after the what-if multiplier
 * @property {number|null} exhaustInMs     projected time until 100%; 0 = already exhausted;
 *                                         null = unknown or not burning
 * @property {boolean|null} survives       projected to reach the reset without exhausting; null = unknown
 * @property {number|null} spareAtResetPct  when it survives: whole percent of the allowance projected
 *                                         to be left at the reset; else null
 * @property {number|null} shortfallMs     when it will not survive: how long before the reset it runs out
 * @property {'ok'|'warn'|'critical'|'exhausted'} level
 * @property {string} forecast             one concrete sentence, e.g.
 *                                         'Fable machine projected to overheat in 2 hours'
 * @property {boolean} stale
 */

/**
 * @typedef {Object} MachineState
 * @property {string} modelKey
 * @property {string} label
 * @property {'fable'|'opus'|'sonnet'|'haiku'|'generic'} design
 * @property {{accent:number, accent2:number, variant:number}} style
 * @property {LimitView|null} limit      null: the plan reports no allowance of its own for this model
 * @property {number} heat               0..1 (0 when limit is null)
 * @property {'idle'|'running'|'hot'|'fire'|'pitstop'|'emergency'} status
 * @property {boolean} powered           status is idle | running | hot
 * @property {number} speed              0..1 work rate from token throughput
 * @property {TokenRate} rate
 * @property {TokenCounts} tokens
 * @property {string[]} residentIds      residents posted at this machine (place 'machine'): every agent
 *                                       on this model that is working, main agents (foremen) included
 */

/**
 * @typedef {Object} ResidentState
 * @property {string} id
 * @property {'main'|'sub'} kind
 * @property {'foreman'|'programmer'|'researcher'|'reviewer'|'operator'} role   stable for the agent's
 *                                       lifetime: from its kind, type and description, not its activity
 * @property {string} name
 * @property {string|null} agentType
 * @property {string|null} project
 * @property {string|null} parentId
 * @property {string|null} parentName
 * @property {string} model              raw model id
 * @property {string} modelKey
 * @property {'control'|'lounge'|'machine'|'exit'} place   where it should be:
 *   machine: working, at its model's machine (main agents too); control: waiting for input,
 *   at the console; lounge: session inactive, no activity for an hour (STALE_AFTER_MS);
 *   exit: finished, clocking out through the elevator. A session with no activity for
 *   24 hours is not in the state at all (HIDE_AFTER_MS).
 * @property {'working'|'waiting'|'done'} status
 * @property {Activity} activity
 * @property {'terminal'|'documents'|'inspection'} station   workstation prop for its role
 * @property {string} icon               one of ICONS in src/gfx/actors.mjs
 * @property {'happy'|'neutral'|'focused'|'sleepy'|'worried'|'shocked'} mood
 * @property {boolean} blocked           its machine cannot run right now (fire, pit stop, emergency)
 * @property {boolean} stale             no activity for STALE_AFTER_MS: it waits in the lounge
 * @property {string|null} tool
 * @property {string|null} task
 * @property {number} startedAt
 * @property {number} lastActiveAt
 * @property {TokenCounts} tokens
 * @property {TokenRate} rate
 */

/**
 * @typedef {Object} Alert
 * @property {string} id                 stable while the condition lasts
 * @property {'info'|'warn'|'critical'} level
 * @property {'model'|'session'|'weekly'|'generator'|'telemetry'} scope
 * @property {string|null} modelKey
 * @property {string} text               concrete: 'Central power will run out 18 hours before reset'
 */

/**
 * @typedef {Object} ShelterState
 * @property {number} now
 * @property {'live'|'simulation'} source
 * @property {string|null} scenario
 * @property {number} whatIf             usage-rate multiplier applied to forecasts and heat (1 = actual)
 * @property {MachineState[]} machines
 * @property {{limit:LimitView|null, status:'ok'|'warn'|'tripped'}} switchboard   the session limit
 * @property {{limit:LimitView|null, heat:number, status:'ok'|'hot'|'critical'|'meltdown',
 *             speed:number}} reactor                                             the weekly limit
 * @property {{present:boolean, running:boolean, utilization:number|null, usedCredits:number|null,
 *             monthlyLimit:number|null, currency:string|null}} generator         extra usage credits.
 *   utilization is a 0..1 FRACTION here (Limits.extra.utilization is 0..100 percent).
 *   usedCredits / monthlyLimit are in minor units of `currency` (cents for USD), as the plan reports them.
 * @property {'normal'|'pitstop'|'emergency'} power   shelter-wide power mode
 *   pitstop: session limit tripped; emergency: weekly limit reached
 * @property {ResidentState[]} residents
 * @property {Alert[]} alerts            most severe first
 * @property {TokenRate} rate            whole-shelter throughput
 * @property {TokenCounts} tokens        whole-shelter totals
 * @property {number} speed              0..1 overall activity (conveyors, pulses)
 * @property {{at:number|null, stale:boolean, error:string|null, known:boolean}} telemetry
 *   known: at least one allowance reading exists (otherwise meters show "no data")
 */

/**
 * Transitions between two consecutive ShelterStates.
 * @typedef {(
 *   {type:'agent_arrived', id:string} |
 *   {type:'agent_left', id:string} |
 *   {type:'agent_model_changed', id:string, from:string, to:string} |
 *   {type:'limit_warning', scope:'model'|'session'|'weekly', modelKey:string|null} |
 *   {type:'limit_reached', scope:'model'|'session'|'weekly', modelKey:string|null} |
 *   {type:'limit_reset', scope:'model'|'session'|'weekly', modelKey:string|null} |
 *   {type:'generator_started'} | {type:'generator_stopped'}
 * )} ShelterEvent
 */

export {};
