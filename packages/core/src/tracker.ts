/**
 * The work queue. ADR 0005: one `Tracker` interface, six operations, two implementations.
 *
 * `LinearTracker` is the real one. `FileTracker` is a fake, and it is what lets a
 * contributor run the whole loop offline with no credential. It is never pointed at a
 * live product.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Lane = "ai" | "human";

export type StateType = "backlog" | "unstarted" | "started" | "completed" | "canceled";

export interface Ticket {
  id: string;
  /** Linear's internal uuid. Mutations need it; nothing else should care. */
  uuid?: string;
  title: string;
  description: string;
  lane: Lane;
  /** Linear's scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  state: string;
  stateType: StateType;
  labels: string[];
  blockedBy: string[];
  createdAt: string;
  url?: string;
  branchName?: string;
}

export interface NewTicket {
  title: string;
  description: string;
  lane: Lane;
  priority: number;
  labels?: string[];
}

export interface Tracker {
  listOpen(): Promise<Ticket[]>;
  get(id: string): Promise<Ticket | undefined>;
  create(ticket: NewTicket): Promise<Ticket>;
  setState(id: string, state: string): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  labels(): Promise<string[]>;
}

export const LANE_LABEL: Record<Lane, string> = { ai: "lane:ai", human: "lane:human" };

function laneFromLabels(labels: string[]): Lane {
  return labels.includes(LANE_LABEL.human) ? "human" : "ai";
}

const OPEN_STATES: StateType[] = ["backlog", "unstarted", "started"];

export function isOpen(ticket: Ticket): boolean {
  return OPEN_STATES.includes(ticket.stateType);
}

/** Linear puts "no priority" at 0, which must sort last, not first. */
function priorityKey(priority: number): number {
  return priority === 0 ? Number.MAX_SAFE_INTEGER : priority;
}

/** Tickets already being worked, oldest first. The ticket state is the lock, not a file. */
export function inFlight(tickets: Ticket[]): Ticket[] {
  return tickets
    .filter((t) => t.stateType === "started")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The one ticket a sequential runner should work next, or nothing.
 *
 * Two rules, both from `integrations/README.md`:
 * 1. finish what is already running before starting more, so a scheduler that wakes twice
 *    resumes rather than doubling up;
 * 2. otherwise the top unblocked ticket by priority, oldest first on a tie.
 *
 * `boundaries.maxTicketsInFlight` is deliberately not a parameter here. Resume-first
 * already means one runner never opens a second ticket, so passing the cap in would be a
 * check that can never fire. The cap belongs where concurrent workers are actually
 * started; `inFlight()` and `atCapacity()` are what that code uses.
 */
export function pickNext(tickets: Ticket[]): Ticket | undefined {
  const open = tickets.filter(isOpen);
  const running = inFlight(open);
  if (running.length > 0) return running[0];

  const openIds = new Set(open.map((t) => t.id));
  return open
    .filter((t) => !t.blockedBy.some((id) => openIds.has(id)))
    .sort(
      (a, b) =>
        priorityKey(a.priority) - priorityKey(b.priority) || a.createdAt.localeCompare(b.createdAt),
    )[0];
}

/**
 * Whether the loop may start another ticket. ponytail: only ever consulted with the
 * documented default of 1 today; it is what a parallel worker pool would gate on.
 */
export function atCapacity(tickets: Ticket[], maxTicketsInFlight: number): boolean {
  return inFlight(tickets.filter(isOpen)).length >= maxTicketsInFlight;
}

/* ------------------------------------------------------------------ FileTracker */

interface FileShape {
  nextNumber: number;
  tickets: Ticket[];
  comments: Record<string, string[]>;
}

const DONE_STATES: Record<string, StateType> = {
  Backlog: "backlog",
  Todo: "unstarted",
  "In Progress": "started",
  "In Review": "started",
  Done: "completed",
  Canceled: "canceled",
};

export function stateTypeFor(state: string): StateType {
  return DONE_STATES[state] ?? "unstarted";
}

/** One JSON file. A fake, not a second tracker (ADR 0005). */
export class FileTracker implements Tracker {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  private read(): FileShape {
    if (!existsSync(this.path)) return { nextNumber: 1, tickets: [], comments: {} };
    return JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
  }

  private write(data: FileShape): void {
    writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`);
  }

  listOpen(): Promise<Ticket[]> {
    return Promise.resolve(this.read().tickets.filter(isOpen));
  }

  listAll(): Promise<Ticket[]> {
    return Promise.resolve(this.read().tickets);
  }

  get(id: string): Promise<Ticket | undefined> {
    return Promise.resolve(this.read().tickets.find((t) => t.id === id));
  }

  create(input: NewTicket): Promise<Ticket> {
    const data = this.read();
    const labels = Array.from(new Set([...(input.labels ?? []), LANE_LABEL[input.lane]]));
    const ticket: Ticket = {
      id: `AP-${data.nextNumber}`,
      title: input.title,
      description: input.description,
      lane: input.lane,
      priority: input.priority,
      state: "Backlog",
      stateType: "backlog",
      labels,
      blockedBy: [],
      createdAt: new Date().toISOString(),
    };
    data.nextNumber += 1;
    data.tickets.push(ticket);
    this.write(data);
    return Promise.resolve(ticket);
  }

  setState(id: string, state: string): Promise<void> {
    const data = this.read();
    const ticket = data.tickets.find((t) => t.id === id);
    if (!ticket) return Promise.reject(new Error(`no ticket ${id}`));
    ticket.state = state;
    ticket.stateType = stateTypeFor(state);
    this.write(data);
    return Promise.resolve();
  }

  comment(id: string, body: string): Promise<void> {
    const data = this.read();
    (data.comments[id] ??= []).push(body);
    this.write(data);
    return Promise.resolve();
  }

  comments(id: string): Promise<string[]> {
    return Promise.resolve(this.read().comments[id] ?? []);
  }

  labels(): Promise<string[]> {
    const data = this.read();
    return Promise.resolve(Array.from(new Set(data.tickets.flatMap((t) => t.labels))));
  }
}

/* ---------------------------------------------------------------- LinearTracker */

export interface LinearOptions {
  apiKey: string;
  project: string;
  team?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  url
  branchName
  createdAt
  state { name type }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { identifier } } }
`;

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  url: string;
  branchName: string;
  createdAt: string;
  state: { name: string; type: string };
  labels: { nodes: { name: string }[] };
  /**
   * The *inverse* direction, deliberately. In Linear, `relations` with `type: "blocks"` means
   * this issue blocks the related one; `inverseRelations` with `type: "blocks"` means the
   * related one blocks this one. Reading `relations` populated `blockedBy` with the tickets a
   * ticket was blocking, so `pickNext` skipped the blocker and cheerfully started the blocked
   * work - the exact inversion of what the field is for.
   */
  inverseRelations?: { nodes: { type: string; issue?: { identifier: string } }[] };
}

/**
 * Raw GraphQL over `fetch`, not `@linear/sdk`. Six operations is about 150 lines; the SDK
 * is a large dependency and a generated client to track for those six calls (ADR 0005).
 *
 * An API key rather than the MCP server, because the continuity engine wakes on a
 * schedule with nobody there to complete an OAuth flow.
 */
export class LinearTracker implements Tracker {
  private readonly apiKey: string;
  private readonly project: string;
  private readonly team: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(options: LinearOptions) {
    if (!options.apiKey) {
      throw new Error(
        "LINEAR_API_KEY is not set. Create a personal API key at " +
          "https://linear.app/settings/account/security and export it, or run with --fake.",
      );
    }
    this.apiKey = options.apiKey;
    this.project = options.project;
    this.team = options.team;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? "https://api.linear.app/graphql";
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      // Never echo the request: the Authorization header is in it.
      throw new Error(`Linear returned HTTP ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (payload.errors?.length) {
      throw new Error(`Linear rejected the query: ${payload.errors.map((e) => e.message).join("; ")}`);
    }
    if (!payload.data) throw new Error("Linear returned no data");
    return payload.data;
  }

  private toTicket(issue: LinearIssue): Ticket {
    const labels = issue.labels.nodes.map((l) => l.name);
    const ticket: Ticket = {
      id: issue.identifier,
      uuid: issue.id,
      title: issue.title,
      description: issue.description ?? "",
      lane: laneFromLabels(labels),
      priority: issue.priority,
      state: issue.state.name,
      stateType: issue.state.type as StateType,
      labels,
      blockedBy: (issue.inverseRelations?.nodes ?? [])
        .filter((r) => r.type === "blocks" && r.issue)
        .map((r) => r.issue!.identifier),
      createdAt: issue.createdAt,
      url: issue.url,
      branchName: issue.branchName,
    };
    return ticket;
  }

  async listOpen(): Promise<Ticket[]> {
    const data = await this.gql<{ issues: { nodes: LinearIssue[] } }>(
      `query Open($project: String!) {
         issues(
           first: 100
           filter: { project: { name: { eq: $project } }, state: { type: { nin: ["completed", "canceled"] } } }
         ) { nodes { ${ISSUE_FIELDS} } }
       }`,
      { project: this.project },
    );
    return data.issues.nodes.map((n) => this.toTicket(n));
  }

  async get(id: string): Promise<Ticket | undefined> {
    const data = await this.gql<{ issue: LinearIssue | null }>(
      `query One($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id },
    );
    return data.issue ? this.toTicket(data.issue) : undefined;
  }

  private async teamId(): Promise<string> {
    const data = await this.gql<{ teams: { nodes: { id: string; name: string }[] } }>(
      `query Teams { teams(first: 50) { nodes { id name } } }`,
    );
    const teams = data.teams.nodes;
    const found = this.team ? teams.find((t) => t.name === this.team || t.id === this.team) : teams[0];
    if (!found) throw new Error(`no Linear team matching ${this.team ?? "(first)"}`);
    return found.id;
  }

  private async projectId(): Promise<string> {
    const data = await this.gql<{ projects: { nodes: { id: string; name: string }[] } }>(
      `query Projects { projects(first: 100) { nodes { id name } } }`,
    );
    const found = data.projects.nodes.find((p) => p.name === this.project || p.id === this.project);
    if (!found) throw new Error(`no Linear project named ${this.project}`);
    return found.id;
  }

  /**
   * Label names to ids. A missing *lane* label is fatal, not something to skip.
   *
   * Silently dropping it was a real bug with a nasty shape: a human-lane ticket created
   * without `lane:human` reads back as `lane:ai` through `laneFromLabels`, so the loop would
   * build a feature the human was supposed to decide on first.
   */
  private async labelIds(names: string[], required: string[] = []): Promise<string[]> {
    if (names.length === 0) return [];
    const data = await this.gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
      `query Labels { issueLabels(first: 250) { nodes { id name } } }`,
    );

    const missingRequired = required.filter(
      (name) => !data.issueLabels.nodes.some((l) => l.name === name),
    );
    if (missingRequired.length > 0) {
      throw new Error(
        `Linear has no label named ${missingRequired.join(", ")}. The lane is a label ` +
          "(integrations/README.md), and a ticket filed without it reads back as the AI lane. " +
          "Create it in Linear, or point tracker.laneLabels at the names you already use.",
      );
    }
    return names
      .map((n) => data.issueLabels.nodes.find((l) => l.name === n)?.id)
      .filter((id): id is string => Boolean(id));
  }

  async create(input: NewTicket): Promise<Ticket> {
    const [teamId, projectId] = await Promise.all([this.teamId(), this.projectId()]);
    const lane = LANE_LABEL[input.lane];
    const labelIds = await this.labelIds(
      Array.from(new Set([...(input.labels ?? []), lane])),
      [lane],
    );

    const data = await this.gql<{ issueCreate: { issue: LinearIssue } }>(
      `mutation Create($input: IssueCreateInput!) {
         issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } }
       }`,
      {
        input: {
          teamId,
          projectId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          labelIds,
        },
      },
    );
    return this.toTicket(data.issueCreate.issue);
  }

  async setState(id: string, state: string): Promise<void> {
    const ticket = await this.get(id);
    if (!ticket?.uuid) throw new Error(`no Linear issue ${id}`);

    const data = await this.gql<{ workflowStates: { nodes: { id: string; name: string }[] } }>(
      `query States { workflowStates(first: 100) { nodes { id name } } }`,
    );
    const target = data.workflowStates.nodes.find((s) => s.name === state);
    if (!target) throw new Error(`no Linear workflow state named ${state}`);

    await this.gql(
      `mutation Move($id: String!, $stateId: String!) {
         issueUpdate(id: $id, input: { stateId: $stateId }) { success }
       }`,
      { id: ticket.uuid, stateId: target.id },
    );
  }

  async comment(id: string, body: string): Promise<void> {
    const ticket = await this.get(id);
    if (!ticket?.uuid) throw new Error(`no Linear issue ${id}`);
    await this.gql(
      `mutation Comment($issueId: String!, $body: String!) {
         commentCreate(input: { issueId: $issueId, body: $body }) { success }
       }`,
      { issueId: ticket.uuid, body },
    );
  }

  async labels(): Promise<string[]> {
    const data = await this.gql<{ issueLabels: { nodes: { name: string }[] } }>(
      `query Labels { issueLabels(first: 250) { nodes { name } } }`,
    );
    return data.issueLabels.nodes.map((l) => l.name);
  }
}

/** Pick the real tracker or the fake, from the config and the environment. */
export function trackerFor(options: {
  fake?: boolean;
  fakePath?: string;
  project: string;
  team?: string;
  apiKey?: string;
}): Tracker {
  if (options.fake) return new FileTracker(options.fakePath ?? ".autopilot/tickets.json");
  const linear: LinearOptions = {
    apiKey: options.apiKey ?? process.env.LINEAR_API_KEY ?? "",
    project: options.project,
  };
  if (options.team) linear.team = options.team;
  return new LinearTracker(linear);
}
