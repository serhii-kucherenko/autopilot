/**
 * `autopilot.config.json` - the only place a product differs (schema/README.md).
 *
 * Two jobs: validate against the published schema, and fill in the defaults the schema
 * documents. Filling them here rather than at each use site means no runner ever has to
 * ask "what if this is undefined", which is where a loop with nobody watching goes wrong.
 */

import { readFileSync, existsSync } from "node:fs";
// Named import, not default: ajv is CommonJS and its `.d.ts` describes a namespace
// that TypeScript will not let you construct. The class is a real named export at runtime.
import { Ajv2020 } from "ajv/dist/2020.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

// ponytail: the schema is read from the repo layout rather than copied into this package,
// so there is exactly one copy of the contract. Vendoring it if core is ever published
// standalone is the upgrade path.
const SCHEMA_URL = new URL("../../../schema/autopilot.config.schema.json", import.meta.url);

export interface Config {
  product: { name: string; vision: string; anchors: string[] };
  tracker: {
    kind: "linear";
    project: string;
    team?: string;
    laneLabels: { ai: string; human: string };
  };
  repo: { root: string; defaultBranch: string; branchPrefix: string };
  environments: {
    staging: { deploy: string; url?: string };
    production?: { deploy?: string; url?: string; requiresHumanApproval: boolean };
  };
  gate: {
    commands: string[];
    featureFlags: { required: boolean; defaultState: "on" | "off" };
  };
  capture: {
    loupe: { enabled: boolean; bundleDir?: string; endpoint?: string };
    conversational: boolean;
  };
  boundaries: {
    protectedPaths: string[];
    forbiddenCommands: string[];
    maxTicketsInFlight: number;
  };
  cadence: {
    engineerInterval?: string;
    digest?: string;
    selfAuditOnEmptyBacklog: boolean;
  };
}

type Validator = ((data: unknown) => boolean) & { errors?: unknown };

let validator: Validator | undefined;

function compileValidator(): Validator {
  const schema = JSON.parse(readFileSync(SCHEMA_URL, "utf8"));
  // strict off: the schema is the published contract, and ajv's strict mode objects to
  // `default` on properties, which is exactly how the contract documents its defaults.
  return new Ajv2020({ allErrors: true, useDefaults: false, strict: false }).compile(schema);
}

function validate(raw: unknown): void {
  const check = (validator ??= compileValidator());
  if (check(raw)) return;

  const errors = (check.errors ?? []) as { instancePath?: string; message?: string }[];
  const lines = errors.map((e) => `  ${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
  throw new ConfigError(`autopilot.config.json is invalid:\n${lines.join("\n")}`);
}

type Raw = Record<string, unknown>;

function section(raw: Raw, key: string): Raw {
  return (raw[key] as Raw | undefined) ?? {};
}

export function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("autopilot.config.json must be a JSON object");
  }
  validate(raw);
  const r = raw as Raw;

  const product = section(r, "product");
  const tracker = section(r, "tracker");
  const laneLabels = section(tracker, "laneLabels");
  const repo = section(r, "repo");
  const environments = section(r, "environments");
  const staging = section(environments, "staging");
  const production = environments.production as Raw | undefined;
  const gate = section(r, "gate");
  const featureFlags = section(gate, "featureFlags");
  const capture = section(r, "capture");
  const loupe = section(capture, "loupe");
  const boundaries = section(r, "boundaries");
  const cadence = section(r, "cadence");

  // docs/architecture.md: the human holds the only production key. The schema defaults
  // this to true; a config that turns it off is refused rather than honoured, because
  // canary release and automatic rollback do not exist yet.
  const requiresHumanApproval = (production?.requiresHumanApproval as boolean | undefined) ?? true;
  if (requiresHumanApproval === false) {
    throw new ConfigError(
      "environments.production.requiresHumanApproval must stay true: the loop deploys to " +
        "staging only until canary release and automatic rollback exist (docs/architecture.md).",
    );
  }

  const config: Config = {
    product: {
      name: product.name as string,
      vision: product.vision as string,
      anchors: (product.anchors as string[] | undefined) ?? ["DESIGN.md", "docs/adr/"],
    },
    tracker: {
      kind: "linear",
      project: tracker.project as string,
      laneLabels: {
        ai: (laneLabels.ai as string | undefined) ?? "lane:ai",
        human: (laneLabels.human as string | undefined) ?? "lane:human",
      },
    },
    repo: {
      root: repo.root as string,
      defaultBranch: (repo.defaultBranch as string | undefined) ?? "main",
      branchPrefix: (repo.branchPrefix as string | undefined) ?? "auto/",
    },
    environments: {
      staging: { deploy: staging.deploy as string },
    },
    gate: {
      commands: gate.commands as string[],
      featureFlags: {
        required: (featureFlags.required as boolean | undefined) ?? true,
        defaultState: ((featureFlags.defaultState as string | undefined) ?? "off") as "on" | "off",
      },
    },
    capture: {
      loupe: { enabled: (loupe.enabled as boolean | undefined) ?? false },
      conversational: (capture.conversational as boolean | undefined) ?? true,
    },
    boundaries: {
      protectedPaths: (boundaries.protectedPaths as string[] | undefined) ?? [],
      forbiddenCommands: (boundaries.forbiddenCommands as string[] | undefined) ?? [],
      maxTicketsInFlight: (boundaries.maxTicketsInFlight as number | undefined) ?? 1,
    },
    cadence: {
      selfAuditOnEmptyBacklog: (cadence.selfAuditOnEmptyBacklog as boolean | undefined) ?? true,
    },
  };

  if (tracker.team) config.tracker.team = tracker.team as string;
  if (staging.url) config.environments.staging.url = staging.url as string;
  if (production) {
    config.environments.production = { requiresHumanApproval };
    if (production.deploy) config.environments.production.deploy = production.deploy as string;
    if (production.url) config.environments.production.url = production.url as string;
  }
  if (loupe.bundleDir) config.capture.loupe.bundleDir = loupe.bundleDir as string;
  if (loupe.endpoint) config.capture.loupe.endpoint = loupe.endpoint as string;
  if (cadence.engineerInterval) config.cadence.engineerInterval = cadence.engineerInterval as string;
  if (cadence.digest) config.cadence.digest = cadence.digest as string;

  return config;
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      `no config at ${path}. Copy schema/example.reco.json to autopilot.config.json in the product repo and edit it.`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`cannot read ${path}: ${(cause as Error).message}`);
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (cause) {
    if (cause instanceof ConfigError) throw new ConfigError(`${path}: ${cause.message}`);
    throw new ConfigError(`${path} is not valid JSON: ${(cause as Error).message}`);
  }
}
