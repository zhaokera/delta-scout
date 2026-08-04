import type {
  PanzhiPageMode,
  PanzhiPageSnapshot
} from "./contracts.js";

const API_ROOT =
  "http://127.0.0.1:4310/api/sources/panzhi/automation" as const;

export type PanzhiAutomationState =
  | "queued"
  | "opening_page"
  | "applying_filters"
  | "collecting"
  | "awaiting_user_verification"
  | "submitting"
  | "success"
  | "failed"
  | "cancelled";

export interface PanzhiAutomationJobView {
  id: string;
  mode: PanzhiPageMode;
  state: PanzhiAutomationState;
  leaseExpiresAt: string | null;
  verificationDeadlineAt: string | null;
  verificationNotifiedAt: string | null;
  error: string | null;
  scanRunId: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface PanzhiAutomationClaim {
  job: PanzhiAutomationJobView;
  bearerToken: string;
}

export interface PanzhiActiveJobIdentity {
  jobId: string;
  bearerToken: string;
  mode: PanzhiPageMode;
}

export interface PanzhiAutomationStateUpdate {
  state:
    | "applying_filters"
    | "collecting"
    | "awaiting_user_verification"
    | "submitting"
    | "failed";
  error?: string;
}

export interface PanzhiAutomationStateResponse {
  job: PanzhiAutomationJobView;
  shouldNotify?: boolean;
}

export interface PanzhiAutomationHeartbeatResponse {
  job: PanzhiAutomationJobView;
  leaseExpiresAt: string;
}

export interface PanzhiAutomationSnapshotResponse {
  deduplicated: boolean;
  [key: string]: unknown;
}

export interface PanzhiAutomationApiPort {
  recordExtensionHeartbeat(): Promise<void>;
  claimJob(): Promise<PanzhiAutomationClaim | null>;
  resumeJob(active: PanzhiActiveJobIdentity): Promise<PanzhiAutomationClaim>;
  heartbeatJob(
    active: PanzhiActiveJobIdentity
  ): Promise<PanzhiAutomationHeartbeatResponse>;
  updateJobState(
    active: PanzhiActiveJobIdentity,
    update: PanzhiAutomationStateUpdate
  ): Promise<PanzhiAutomationStateResponse>;
  submitSnapshot(
    active: PanzhiActiveJobIdentity,
    snapshot: PanzhiPageSnapshot
  ): Promise<PanzhiAutomationSnapshotResponse>;
}

export class PanzhiAutomationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PanzhiAutomationApiError";
  }
}

export class PanzhiAutomationNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PanzhiAutomationNetworkError";
  }
}

export class PanzhiAutomationProtocolError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PanzhiAutomationProtocolError";
  }
}

type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PanzhiAutomationProtocolError(
      "Panzhi automation API returned an invalid object"
    );
  }
  return value as Record<string, unknown>;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new PanzhiAutomationProtocolError(
    `Panzhi automation API returned invalid ${field}`
  );
}

const JOB_STATES: ReadonlySet<string> = new Set([
  "queued",
  "opening_page",
  "applying_filters",
  "collecting",
  "awaiting_user_verification",
  "submitting",
  "success",
  "failed",
  "cancelled"
]);

function parseJob(value: unknown): PanzhiAutomationJobView {
  const input = record(value);
  if (
    typeof input.id !== "string" ||
    (input.mode !== "quick" && input.mode !== "deep") ||
    typeof input.state !== "string" ||
    !JOB_STATES.has(input.state) ||
    typeof input.createdAt !== "string" ||
    typeof input.updatedAt !== "string" ||
    (input.scanRunId !== null && typeof input.scanRunId !== "number")
  ) {
    throw new PanzhiAutomationProtocolError(
      "Panzhi automation API returned an invalid job"
    );
  }
  return {
    id: input.id,
    mode: input.mode,
    state: input.state as PanzhiAutomationState,
    leaseExpiresAt: nullableString(input.leaseExpiresAt, "leaseExpiresAt"),
    verificationDeadlineAt: nullableString(
      input.verificationDeadlineAt,
      "verificationDeadlineAt"
    ),
    verificationNotifiedAt: nullableString(
      input.verificationNotifiedAt,
      "verificationNotifiedAt"
    ),
    error: nullableString(input.error, "error"),
    scanRunId: input.scanRunId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    finishedAt: nullableString(input.finishedAt, "finishedAt")
  };
}

function parseClaim(value: unknown): PanzhiAutomationClaim {
  const input = record(value);
  if (typeof input.bearerToken !== "string") {
    throw new PanzhiAutomationProtocolError(
      "Panzhi automation API omitted its bearer token"
    );
  }
  return { job: parseJob(input.job), bearerToken: input.bearerToken };
}

function bearer(active: PanzhiActiveJobIdentity): Record<string, string> {
  return { Authorization: `Bearer ${active.bearerToken}` };
}

export class PanzhiAutomationApi implements PanzhiAutomationApiPort {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async recordExtensionHeartbeat(): Promise<void> {
    await this.requestJson(`${API_ROOT}/heartbeat`, { method: "POST", body: {} });
  }

  async claimJob(): Promise<PanzhiAutomationClaim | null> {
    const response = await this.requestJson(
      `${API_ROOT}/jobs/claim`,
      { method: "POST", body: {} },
      true
    );
    return response === null ? null : parseClaim(response);
  }

  async resumeJob(
    active: PanzhiActiveJobIdentity
  ): Promise<PanzhiAutomationClaim> {
    return parseClaim(await this.requestJson(`${API_ROOT}/jobs/claim`, {
      method: "POST",
      headers: bearer(active),
      body: { jobId: active.jobId }
    }));
  }

  async heartbeatJob(
    active: PanzhiActiveJobIdentity
  ): Promise<PanzhiAutomationHeartbeatResponse> {
    const input = record(await this.jobRequest(active, "heartbeat", {}));
    if (typeof input.leaseExpiresAt !== "string") {
      throw new PanzhiAutomationProtocolError(
        "Panzhi heartbeat omitted its lease expiry"
      );
    }
    return { job: parseJob(input.job), leaseExpiresAt: input.leaseExpiresAt };
  }

  async updateJobState(
    active: PanzhiActiveJobIdentity,
    update: PanzhiAutomationStateUpdate
  ): Promise<PanzhiAutomationStateResponse> {
    const input = record(await this.jobRequest(active, "state", update));
    if (
      input.shouldNotify !== undefined &&
      typeof input.shouldNotify !== "boolean"
    ) {
      throw new PanzhiAutomationProtocolError(
        "Panzhi state response has invalid notification state"
      );
    }
    return {
      job: parseJob(input.job),
      ...(input.shouldNotify === undefined
        ? {}
        : { shouldNotify: input.shouldNotify })
    };
  }

  async submitSnapshot(
    active: PanzhiActiveJobIdentity,
    snapshot: PanzhiPageSnapshot
  ): Promise<PanzhiAutomationSnapshotResponse> {
    const input = record(await this.jobRequest(active, "snapshot", snapshot));
    if (typeof input.deduplicated !== "boolean") {
      throw new PanzhiAutomationProtocolError(
        "Panzhi snapshot response is invalid"
      );
    }
    return { ...input, deduplicated: input.deduplicated };
  }

  private jobRequest(
    active: PanzhiActiveJobIdentity,
    action: "heartbeat" | "state" | "snapshot",
    body: unknown
  ): Promise<unknown> {
    return this.requestJson(
      `${API_ROOT}/jobs/${encodeURIComponent(active.jobId)}/${action}`,
      { method: "POST", headers: bearer(active), body }
    );
  }

  private async requestJson(
    url: string,
    request: {
      method: "POST";
      headers?: Record<string, string>;
      body: unknown;
    },
    allowNoContent = false
  ): Promise<unknown | null> {
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(url, {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          ...request.headers
        },
        body: JSON.stringify(request.body)
      });
    } catch (error) {
      throw new PanzhiAutomationNetworkError(
        "Panzhi automation API is unreachable",
        error
      );
    }
    if (allowNoContent && response.status === 204) return null;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      if (response.ok) {
        throw new PanzhiAutomationProtocolError(
          "Panzhi automation API returned invalid JSON"
        );
      }
    }
    if (!response.ok) {
      const error = body === null ? {} : record(body);
      throw new PanzhiAutomationApiError(
        response.status,
        typeof error.error === "string" ? error.error : "http_error",
        typeof error.message === "string"
          ? error.message
          : `Panzhi automation request failed (${response.status})`
      );
    }
    return body;
  }
}
