import { readFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApp, listen } from "../src/http-server.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { VoiceLabService } from "../src/service.js";
import { testConfig } from "./helpers.js";

interface BlueprintEnvVar {
  fromGroup?: string;
  key?: string;
  sync?: boolean;
  value?: string;
}

interface BlueprintService {
  type?: string;
  name?: string;
  dockerfilePath?: string;
  dockerCommand?: string;
  envVars?: BlueprintEnvVar[];
  healthCheckPath?: string;
}

interface Blueprint {
  envVarGroups?: Array<{ name?: string; envVars?: BlueprintEnvVar[] }>;
  services?: BlueprintService[];
}

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const BLUEPRINT_PATH = path.join(REPOSITORY_ROOT, "render.voice-lab.yaml");
const DOCKERFILE_PATH = path.join(PACKAGE_ROOT, "Dockerfile");
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, "package.json");
const MIGRATE_SOURCE_PATH = path.join(PACKAGE_ROOT, "src/bin/migrate.ts");

async function deploymentContract(): Promise<{ blueprint: Blueprint; dockerfile: string }> {
  const [blueprintSource, dockerfile] = await Promise.all([
    readFile(BLUEPRINT_PATH, "utf8"),
    readFile(DOCKERFILE_PATH, "utf8"),
  ]);
  return { blueprint: parse(blueprintSource) as Blueprint, dockerfile };
}

function requiredService(blueprint: Blueprint, name: string): BlueprintService {
  const service = blueprint.services?.find((candidate) => candidate.name === name);
  if (!service) throw new Error(`Missing Blueprint service ${name}.`);
  return service;
}

function requiredRuntimeValue(blueprint: Blueprint, key: string): string {
  const group = blueprint.envVarGroups?.find((candidate) => candidate.name === "sophia-voice-lab-runtime-v1");
  const value = group?.envVars?.find((candidate) => candidate.key === key)?.value;
  if (!value) throw new Error(`Missing runtime value ${key}.`);
  return value;
}

async function statusWithHost(endpoint: string, host: string): Promise<number> {
  const url = new URL(endpoint);
  return new Promise<number>((resolve, reject) => {
    const requestHandle = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { host },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    requestHandle.once("error", reject);
    requestHandle.end();
  });
}

describe("Voice Lab deployment health contract", () => {
  const servers: Array<{ close: (callback?: (error?: Error) => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    vi.restoreAllMocks();
  });

  it("uses local liveness for Render while retaining full readiness as a separate campaign gate", async () => {
    const { blueprint, dockerfile } = await deploymentContract();
    const web = requiredService(blueprint, "sophia-voice-lab-mcp");
    const worker = requiredService(blueprint, "sophia-voice-lab-worker");

    expect(web).toMatchObject({
      type: "web",
      dockerfilePath: "./tools/sophia-voice-lab/Dockerfile",
      dockerCommand: "pnpm start:web",
      healthCheckPath: "/healthz",
    });
    expect(worker).toMatchObject({
      type: "worker",
      dockerfilePath: web.dockerfilePath,
      dockerCommand: "pnpm start:worker",
    });
    expect(worker.healthCheckPath).toBeUndefined();
    expect(dockerfile).not.toMatch(/^\s*HEALTHCHECK\b/im);
  });

  it("starts the compiled entrypoints at the paths emitted by the production TypeScript build", async () => {
    const [{ scripts }, { dockerfile }] = await Promise.all([
      readFile(PACKAGE_JSON_PATH, "utf8").then((source) => JSON.parse(source) as { scripts: Record<string, string> }),
      deploymentContract(),
    ]);

    expect(scripts.migrate).toBe("node dist/src/bin/migrate.js");
    expect(scripts["start:web"]).toBe("node dist/src/bin/migrate.js && node dist/src/bin/web.js");
    expect(scripts["start:worker"]).toBe("node dist/src/bin/migrate.js && node dist/src/bin/worker.js");
    expect(dockerfile).toContain('CMD ["sh", "-c", "node dist/src/bin/migrate.js && node dist/src/bin/web.js"]');
  });

  it("resolves the immutable migration from the package working directory in source and compiled builds", async () => {
    const source = await readFile(MIGRATE_SOURCE_PATH, "utf8");
    expect(source).toContain('path.resolve(process.cwd(), "../../backend/migrations/2026_08_23_sophia_voice_lab.sql")');
    expect(source).not.toContain('path.dirname(fileURLToPath(import.meta.url))');
  });

  it("keeps dashboard-managed values directly on both services instead of unsupported sync-false environment groups", async () => {
    const { blueprint } = await deploymentContract();
    const web = requiredService(blueprint, "sophia-voice-lab-mcp");
    const worker = requiredService(blueprint, "sophia-voice-lab-worker");
    const groups = blueprint.envVarGroups ?? [];

    expect(groups.map((group) => group.name)).toEqual(["sophia-voice-lab-runtime-v1"]);
    for (const group of groups) {
      for (const envVar of group.envVars ?? []) {
        expect(envVar.sync).toBeUndefined();
        expect(envVar.value, `${group.name}:${envVar.key}`).toBeTypeOf("string");
      }
    }

    const sharedDashboardKeys = [
      "SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA",
      "SOPHIA_VOICE_LAB_PLUGIN_PACKAGE_SHA256",
      "SOPHIA_VOICE_LAB_PLUGIN_VERSION",
      "SOPHIA_VOICE_LAB_REGISTERED_APP_ID",
      "SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA",
      "SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA",
      "SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA",
      "SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA",
      "SOPHIA_VOICE_LAB_ATTESTATION_PUBLIC_KEYS_JSON",
      "SOPHIA_VOICE_LAB_BEARER_TOKEN",
      "SOPHIA_VOICE_LAB_FAULT_BEARER_TOKEN",
      "SOPHIA_VOICE_LAB_PRINCIPAL_ID",
      "SOPHIA_VOICE_LAB_CAPABILITY_SECRET",
      "SOPHIA_VOICE_LAB_GRANT_SECRET",
      "SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET",
      "SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON",
      "SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET",
      "SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER",
    ];
    for (const service of [web, worker]) {
      const serviceEnv = new Map((service.envVars ?? []).filter((entry) => entry.key).map((entry) => [entry.key, entry]));
      for (const key of sharedDashboardKeys) {
        expect(serviceEnv.get(key), `${service.name}:${key}`).toMatchObject({ key, sync: false });
      }
    }

    expect(requiredRuntimeValue(blueprint, "SOPHIA_VOICE_LAB_OAUTH_ACCESS_TOKEN_TTL_SECONDS")).toBe("300");
    expect(requiredRuntimeValue(blueprint, "SOPHIA_VOICE_LAB_OAUTH_REFRESH_TOKEN_TTL_SECONDS")).toBe("604800");
    expect(requiredRuntimeValue(blueprint, "SOPHIA_VOICE_LAB_START_OPERATION_SECONDS")).toBe("300");
    const parsed = testConfig({
      SOPHIA_VOICE_LAB_OAUTH_ISSUER: "https://voice-lab.test",
      SOPHIA_VOICE_LAB_OAUTH_RESOURCE: "https://voice-lab.test/mcp",
      SOPHIA_VOICE_LAB_OAUTH_RESOURCE_METADATA_URL: "https://voice-lab.test/.well-known/oauth-protected-resource/mcp",
      SOPHIA_VOICE_LAB_OAUTH_CLIENT_METADATA_URL: "https://chatgpt.com/oauth/client.json",
      SOPHIA_VOICE_LAB_OAUTH_CLIENT_REDIRECT_URI: "https://chatgpt.com/connector_platform_oauth_redirect",
      SOPHIA_VOICE_LAB_OAUTH_OPERATOR_SUBJECT: "voice-lab-private-operator",
      SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET: "oauth-consent-secret-000000000000000001",
      SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER: "oauth-token-pepper-0000000000000000002",
    });
    expect(parsed.oauth).toMatchObject({ accessTokenTtlSeconds: 300, refreshTokenTtlSeconds: 604_800 });
    expect(parsed.startOperationSeconds).toBe(300);
  });

  it("accepts the container-local health host while retaining explicit host validation", async () => {
    const { blueprint } = await deploymentContract();
    const allowedHosts = requiredRuntimeValue(blueprint, "SOPHIA_VOICE_LAB_ALLOWED_HOSTS");
    expect(new Set(allowedHosts.split(","))).toEqual(new Set([
      "sophia-voice-lab-mcp.onrender.com",
      "localhost",
      "127.0.0.1",
    ]));

    const config = testConfig({ SOPHIA_VOICE_LAB_ALLOWED_HOSTS: allowedHosts });
    const ledger = new MemoryVoiceLabLedger("test");
    const service = new VoiceLabService(ledger, config, async () => []);
    const app = createHttpApp(config, service, ledger, {
      authenticate: vi.fn(async () => ({ subject: "health-test", scopes: new Set(["voice_lab:read"]) })),
    });
    const server = await listen(app, 0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing health-test server address.");
    const endpoint = `http://127.0.0.1:${address.port}/healthz`;

    const local = await fetch(endpoint);
    expect(local.status).toBe(200);
    await expect(local.json()).resolves.toMatchObject({ status: "ok", service: "sophia-voice-lab-mcp" });
    await expect(statusWithHost(endpoint, `localhost:${address.port}`)).resolves.toBe(200);

    await expect(statusWithHost(endpoint, "attacker.invalid")).resolves.toBe(403);
  });
});
