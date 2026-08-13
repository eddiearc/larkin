import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { exactMode } from "./secure-metadata.js";

export type CardActionCallbackStatus = "missing" | "requested-unverified" | "probe-issued" | "verified-effective";

export interface CardActionCallbackCapability {
  status: Exclude<CardActionCallbackStatus, "missing">;
  requestedAt: string;
  probeNonce?: string;
  probeIssuedAt?: string;
  verifiedAt?: string;
  verifiedEventId?: string;
}

export interface DocumentCommentEventCapability {
  status: "requested-unverified";
  event: "drive.notice.comment_add_v1";
  scope: "drive:drive";
  requestedAt: string;
}

export interface DocumentCommentReplyCapability {
  status: "requested-unverified";
  scope: "docs:document.comment:create";
  requestedAt: string;
}

export type DocumentCommentSubscriptionDimension = "application";
export type DocumentCommentSubscriptionCapability =
  | {
    mode: "none";
    status: "safe-default";
    source: "setup-default";
    updatedAt: string;
  }
  | {
    mode: "none";
    status: "requested-unverified";
    source: "setup-opt-in";
    dimension: DocumentCommentSubscriptionDimension;
    requestedAt: string;
  }
  | {
    mode: "subscribed";
    status: "platform-verified";
    source: "platform-status";
    dimension: DocumentCommentSubscriptionDimension;
    requestedAt: string;
    verifiedAt: string;
  };

export interface EffectiveDocumentCommentSubscription {
  mode: "none" | "subscribed";
  status: "safe-default" | "requested-unverified" | "platform-verified";
  source: "legacy-default" | "setup-default" | "setup-opt-in" | "platform-status";
  dimension: DocumentCommentSubscriptionDimension | null;
}

interface CredentialRecord extends Record<string, unknown> {
  capabilities?: {
    cardActionCallback?: CardActionCallbackCapability;
    documentCommentEvent?: DocumentCommentEventCapability;
    documentCommentReply?: DocumentCommentReplyCapability;
    documentCommentSubscription?: DocumentCommentSubscriptionCapability;
    [key: string]: unknown;
  };
}

const APP_ID = /^cli_[A-Za-z0-9]+$/;
const NONCE = /^[a-f0-9]{32}$/;

function credentialFile(configDir: string, appId: string): string {
  if (!APP_ID.test(appId)) throw new Error("invalid callback capability App ID");
  return path.join(path.resolve(configDir), "bots", `${appId}.json`);
}

function readCredential(file: string): CredentialRecord {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !exactMode(stat, 0o600)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("callback capability credential must be an owned 0600 regular file");
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("callback capability credential is invalid");
  return value as CredentialRecord;
}

function writeCredential(file: string, value: CredentialRecord): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("callback capability credential became a symlink");
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function callbackCapability(value: unknown): CardActionCallbackCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capabilities = (value as CredentialRecord).capabilities;
  const capability = capabilities?.cardActionCallback;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || Object.getPrototypeOf(capabilities) !== Object.prototype
      || !capability || typeof capability !== "object" || Array.isArray(capability) || Object.getPrototypeOf(capability) !== Object.prototype
      || Object.keys(capability).some((key) => !["status", "requestedAt", "probeNonce", "probeIssuedAt", "verifiedAt", "verifiedEventId"].includes(key))
      || !["requested-unverified", "probe-issued", "verified-effective"].includes(capability.status)
      || typeof capability.requestedAt !== "string" || !Number.isFinite(Date.parse(capability.requestedAt))) return null;
  if (capability.status === "probe-issued" && (!capability.probeNonce || !NONCE.test(capability.probeNonce))) return null;
  if (capability.status === "verified-effective" && (!capability.verifiedAt || !Number.isFinite(Date.parse(capability.verifiedAt)))) return null;
  return capability;
}

export function documentCommentCapability(value: unknown): DocumentCommentEventCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capabilities = (value as CredentialRecord).capabilities;
  const capability = capabilities?.documentCommentEvent;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || Object.getPrototypeOf(capabilities) !== Object.prototype
      || !capability || typeof capability !== "object" || Array.isArray(capability) || Object.getPrototypeOf(capability) !== Object.prototype
      || Object.keys(capability).some((key) => !["status", "event", "scope", "requestedAt"].includes(key))
      || capability.status !== "requested-unverified"
      || capability.event !== "drive.notice.comment_add_v1"
      || capability.scope !== "drive:drive"
      || typeof capability.requestedAt !== "string" || !Number.isFinite(Date.parse(capability.requestedAt))) return null;
  return capability;
}

export function documentCommentReplyCapability(value: unknown): DocumentCommentReplyCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capabilities = (value as CredentialRecord).capabilities;
  const capability = capabilities?.documentCommentReply;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || Object.getPrototypeOf(capabilities) !== Object.prototype
      || !capability || typeof capability !== "object" || Array.isArray(capability) || Object.getPrototypeOf(capability) !== Object.prototype
      || Object.keys(capability).some((key) => !["status", "scope", "requestedAt"].includes(key))
      || capability.status !== "requested-unverified"
      || capability.scope !== "docs:document.comment:create"
      || typeof capability.requestedAt !== "string" || !Number.isFinite(Date.parse(capability.requestedAt))) return null;
  return capability;
}

export function documentCommentSubscriptionCapability(value: unknown): DocumentCommentSubscriptionCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capabilities = (value as CredentialRecord).capabilities;
  const capability = capabilities?.documentCommentSubscription;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || Object.getPrototypeOf(capabilities) !== Object.prototype
      || !capability || typeof capability !== "object" || Array.isArray(capability) || Object.getPrototypeOf(capability) !== Object.prototype) return null;
  const keys = Object.keys(capability);
  if (capability.mode === "none" && capability.status === "safe-default" && capability.source === "setup-default") {
    return keys.length === 4 && keys.every((key) => ["mode", "status", "source", "updatedAt"].includes(key))
      && typeof capability.updatedAt === "string" && Number.isFinite(Date.parse(capability.updatedAt)) ? capability : null;
  }
  if (capability.mode === "none" && capability.status === "requested-unverified" && capability.source === "setup-opt-in") {
    return keys.length === 5 && keys.every((key) => ["mode", "status", "source", "dimension", "requestedAt"].includes(key))
      && capability.dimension === "application"
      && typeof capability.requestedAt === "string" && Number.isFinite(Date.parse(capability.requestedAt)) ? capability : null;
  }
  if (capability.mode === "subscribed" && capability.status === "platform-verified" && capability.source === "platform-status") {
    return keys.length === 6 && keys.every((key) => ["mode", "status", "source", "dimension", "requestedAt", "verifiedAt"].includes(key))
      && capability.dimension === "application"
      && typeof capability.requestedAt === "string" && Number.isFinite(Date.parse(capability.requestedAt))
      && typeof capability.verifiedAt === "string" && Number.isFinite(Date.parse(capability.verifiedAt)) ? capability : null;
  }
  return null;
}

export function effectiveDocumentCommentSubscription(value: unknown): EffectiveDocumentCommentSubscription {
  const capability = documentCommentSubscriptionCapability(value);
  if (!capability) return { mode: "none", status: "safe-default", source: "legacy-default", dimension: null };
  return {
    mode: capability.mode,
    status: capability.status,
    source: capability.source,
    dimension: "dimension" in capability ? capability.dimension : null,
  };
}

export function readDocumentCommentSubscription(configDir: string, appId: string): EffectiveDocumentCommentSubscription {
  return effectiveDocumentCommentSubscription(readCredential(credentialFile(configDir, appId)));
}

export function readDocumentCommentCapability(configDir: string, appId: string): DocumentCommentEventCapability | null {
  return documentCommentCapability(readCredential(credentialFile(configDir, appId)));
}

export function readDocumentCommentReplyCapability(configDir: string, appId: string): DocumentCommentReplyCapability | null {
  return documentCommentReplyCapability(readCredential(credentialFile(configDir, appId)));
}

export function markDocumentCommentSubscriptionVerified(
  configDir: string,
  appId: string,
  dimension: DocumentCommentSubscriptionDimension,
  now = Date.now(),
): DocumentCommentSubscriptionCapability {
  const file = credentialFile(configDir, appId);
  const credential = readCredential(file);
  const prior = documentCommentSubscriptionCapability(credential);
  if (!prior || prior.status !== "requested-unverified" || prior.dimension !== dimension) {
    throw new Error("document comment subscription was not explicitly requested for this dimension");
  }
  const capability: DocumentCommentSubscriptionCapability = {
    mode: "subscribed",
    status: "platform-verified",
    source: "platform-status",
    dimension,
    requestedAt: prior.requestedAt,
    verifiedAt: new Date(now).toISOString(),
  };
  credential.capabilities = { ...(credential.capabilities || {}), documentCommentSubscription: capability };
  writeCredential(file, credential);
  return capability;
}

export function readCallbackCapability(configDir: string, appId: string): CardActionCallbackCapability | null {
  return callbackCapability(readCredential(credentialFile(configDir, appId)));
}

export function markCallbackRequested(configDir: string, appId: string, now = Date.now()): CardActionCallbackCapability {
  const file = credentialFile(configDir, appId);
  const credential = readCredential(file);
  const prior = callbackCapability(credential);
  const capability: CardActionCallbackCapability = {
    status: "requested-unverified",
    requestedAt: prior?.requestedAt || new Date(now).toISOString(),
  };
  credential.capabilities = { ...(credential.capabilities || {}), cardActionCallback: capability };
  writeCredential(file, credential);
  return capability;
}

export function markSetupCapabilitiesRequested(
  configDir: string,
  appId: string,
  now = Date.now(),
  commentSubscription?: DocumentCommentSubscriptionDimension | "none",
): {
  cardActionCallback: CardActionCallbackCapability;
  documentCommentEvent: DocumentCommentEventCapability;
  documentCommentReply: DocumentCommentReplyCapability;
  documentCommentSubscription: DocumentCommentSubscriptionCapability;
} {
  const file = credentialFile(configDir, appId);
  const credential = readCredential(file);
  const priorCallback = callbackCapability(credential);
  const priorComment = documentCommentCapability(credential);
  const priorReply = documentCommentReplyCapability(credential);
  const priorSubscription = documentCommentSubscriptionCapability(credential);
  const requestedAt = new Date(now).toISOString();
  const cardActionCallback: CardActionCallbackCapability = {
    status: "requested-unverified",
    requestedAt: priorCallback?.requestedAt || requestedAt,
  };
  const documentCommentEvent: DocumentCommentEventCapability = {
    status: "requested-unverified",
    event: "drive.notice.comment_add_v1",
    scope: "drive:drive",
    requestedAt: priorComment?.requestedAt || requestedAt,
  };
  const documentCommentReply: DocumentCommentReplyCapability = {
    status: "requested-unverified",
    scope: "docs:document.comment:create",
    requestedAt: priorReply?.requestedAt || requestedAt,
  };
  const documentCommentSubscription: DocumentCommentSubscriptionCapability = commentSubscription === "application"
    ? {
      mode: "none",
      status: "requested-unverified",
      source: "setup-opt-in",
      dimension: commentSubscription,
      requestedAt: requestedAt,
    }
    : commentSubscription === "none" || !priorSubscription
      ? { mode: "none", status: "safe-default", source: "setup-default", updatedAt: requestedAt }
      : priorSubscription;
  credential.capabilities = { ...(credential.capabilities || {}), cardActionCallback, documentCommentEvent, documentCommentReply, documentCommentSubscription };
  writeCredential(file, credential);
  return { cardActionCallback, documentCommentEvent, documentCommentReply, documentCommentSubscription };
}

export function issueCallbackProbe(configDir: string, appId: string, now = Date.now(), random = randomUUID): { nonce: string; capability: CardActionCallbackCapability } {
  const file = credentialFile(configDir, appId);
  const credential = readCredential(file);
  const prior = callbackCapability(credential);
  if (!prior) throw new Error("card.action.trigger was not requested by setup; rerun larkin setup first");
  if (prior.status === "verified-effective") return { nonce: "", capability: prior };
  const nonce = random().replaceAll("-", "").slice(0, 32);
  if (!NONCE.test(nonce)) throw new Error("callback probe nonce generator returned an invalid value");
  const capability: CardActionCallbackCapability = {
    status: "probe-issued",
    requestedAt: prior.requestedAt,
    probeNonce: nonce,
    probeIssuedAt: new Date(now).toISOString(),
  };
  credential.capabilities = { ...(credential.capabilities || {}), cardActionCallback: capability };
  writeCredential(file, credential);
  return { nonce, capability };
}

export function verifyCallbackProbe(configDir: string, appId: string, nonce: string, eventId: string, now = Date.now()): boolean {
  if (!NONCE.test(nonce) || !eventId) return false;
  const file = credentialFile(configDir, appId);
  const credential = readCredential(file);
  const prior = callbackCapability(credential);
  if (!prior || prior.status !== "probe-issued" || prior.probeNonce !== nonce) return false;
  credential.capabilities = {
    ...(credential.capabilities || {}),
    cardActionCallback: {
      status: "verified-effective",
      requestedAt: prior.requestedAt,
      verifiedAt: new Date(now).toISOString(),
      verifiedEventId: eventId,
    } satisfies CardActionCallbackCapability,
  };
  writeCredential(file, credential);
  return true;
}
