export type Source = "userInput" | "template" | "systemPrompt" | "skill" | "extension";
export type Display = "always" | "never" | "errors";

export interface SourceConfig {
  files: boolean;
  commands: boolean;
  display: Display;
}

export interface Limits {
  maxFileBytes: number;
  maxCommandBytes: number;
  maxTotalBytes: number;
}

export interface Settings {
  limits: Limits;
  defaults: SourceConfig;
  sources: Partial<Record<Source, Partial<SourceConfig>>>;
}

interface SettingsOverrides {
  limits?: Partial<Limits>;
  defaults?: Partial<SourceConfig>;
  sources?: Partial<Record<Source, Partial<SourceConfig>>>;
}

export interface SettingsIssue {
  path: string;
  code: "invalid-object" | "invalid-value" | "unknown-key";
}

const SOURCES: Source[] = ["userInput", "template", "systemPrompt", "skill", "extension"];

export const DEFAULT_SETTINGS: Settings = {
  limits: { maxFileBytes: 100_000, maxCommandBytes: 100_000, maxTotalBytes: 1_000_000 },
  defaults: { files: true, commands: true, display: "always" },
  sources: {
    template: { commands: false },
    systemPrompt: { display: "never" },
    skill: { commands: false, display: "never" },
    extension: { commands: false, display: "never" },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate external data without I/O or retaining invalid values in diagnostics. */
export function validateSettings(value: unknown): {
  settings: SettingsOverrides;
  issues: SettingsIssue[];
} {
  const issues: SettingsIssue[] = [];
  const settings: SettingsOverrides = {};
  if (!isObject(value)) {
    return { settings, issues: [{ path: "$", code: "invalid-object" }] };
  }

  function validateConfig(value: unknown, path: string): Partial<SourceConfig> {
    const config: Partial<SourceConfig> = {};
    if (!isObject(value)) {
      issues.push({ path, code: "invalid-object" });
      return config;
    }
    for (const [key, field] of Object.entries(value)) {
      if (key === "files" || key === "commands") {
        if (typeof field === "boolean") config[key] = field;
        else issues.push({ path: `${path}.${key}`, code: "invalid-value" });
      } else if (key === "display") {
        if (field === "always" || field === "never" || field === "errors") {
          config.display = field;
        } else issues.push({ path: `${path}.display`, code: "invalid-value" });
      } else {
        issues.push({ path, code: "unknown-key" });
      }
    }
    return config;
  }

  for (const [key, field] of Object.entries(value)) {
    if (key === "limits") {
      if (!isObject(field)) {
        issues.push({ path: "limits", code: "invalid-object" });
        continue;
      }
      settings.limits = {};
      for (const [name, limit] of Object.entries(field)) {
        if (name !== "maxFileBytes" && name !== "maxCommandBytes" && name !== "maxTotalBytes") {
          issues.push({ path: "limits", code: "unknown-key" });
        } else if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
          settings.limits[name] = limit;
        } else issues.push({ path: `limits.${name}`, code: "invalid-value" });
      }
    } else if (key === "defaults") {
      settings.defaults = validateConfig(field, "defaults");
    } else if (key === "sources") {
      if (!isObject(field)) {
        issues.push({ path: "sources", code: "invalid-object" });
        continue;
      }
      settings.sources = {};
      for (const [source, config] of Object.entries(field)) {
        const knownSource = SOURCES.find((candidate) => candidate === source);
        if (knownSource) {
          settings.sources[knownSource] = validateConfig(config, `sources.${knownSource}`);
        } else issues.push({ path: "sources", code: "unknown-key" });
      }
    } else issues.push({ path: "$", code: "unknown-key" });
  }
  return { settings, issues };
}

/** Inputs are validated overrides. Source policy is more specific than defaults. */
export function mergeSettings(
  global: SettingsOverrides,
  project: SettingsOverrides,
): Settings {
  const sources: Settings["sources"] = {};
  for (const source of SOURCES) {
    sources[source] = {
      ...DEFAULT_SETTINGS.sources[source],
      ...global.defaults,
      ...project.defaults,
      ...global.sources?.[source],
      ...project.sources?.[source],
    };
  }
  return {
    limits: { ...DEFAULT_SETTINGS.limits, ...global.limits, ...project.limits },
    defaults: { ...DEFAULT_SETTINGS.defaults, ...global.defaults, ...project.defaults },
    sources,
  };
}

export function cfgFor(settings: Settings, source: Source): SourceConfig {
  return { ...settings.defaults, ...settings.sources[source] };
}

export function shouldDisplay(display: Display, result: "ok" | "error" | "skipped"): boolean {
  return display === "always" || (display === "errors" && result !== "ok");
}
