import fs from "node:fs";
import path from "node:path";

import { callbackCapability, type CardActionCallbackCapability } from "../platform/callback-capability.js";

const BOT_CREDENTIAL_FIELDS = new Set(["appId", "appSecret", "tenant", "ownerOpenId", "createdAt", "updatedAt", "capabilities"]);

export interface BotCredentialRecord {
  appId: string;
  appSecret: string;
  tenant: "feishu" | "lark";
  ownerOpenId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  capabilities?: { cardActionCallback?: CardActionCallbackCapability };
}

export function validCredentialRecord(value: unknown, appId: string): value is BotCredentialRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !BOT_CREDENTIAL_FIELDS.has(field))) return false;
  if (record.appId !== appId || typeof record.appSecret !== "string" || !record.appSecret.trim()
      || !["feishu", "lark"].includes(record.tenant as string)) return false;
  if (Object.hasOwn(record, "ownerOpenId") && record.ownerOpenId !== null && typeof record.ownerOpenId !== "string") return false;
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (Object.hasOwn(record, field)
        && (typeof record[field] !== "string" || !record[field] || !Number.isFinite(Date.parse(record[field])))) return false;
  }
  if (Object.hasOwn(record, "capabilities")) {
    if (!record.capabilities || typeof record.capabilities !== "object" || Array.isArray(record.capabilities)
        || Object.keys(record.capabilities as object).some((key) => key !== "cardActionCallback")
        || !callbackCapability(record)) return false;
  }
  return true;
}

function isOwnedWithExactMode(stat: fs.Stats, mode: number): boolean {
  return (typeof process.getuid !== "function" || stat.uid === process.getuid()) && (stat.mode & 0o777) === mode;
}

export function assertSecureBotsDirectory(botsDir: string): void {
  const stat = fs.lstatSync(botsDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedWithExactMode(stat, 0o700)) {
    throw new Error("unsafe bots directory");
  }
}

export function readSecureBotCredential(botsDir: string, appId: string): unknown {
  const resolvedBotsDir = path.resolve(botsDir);
  const credentialFile = path.resolve(resolvedBotsDir, `${appId}.json`);
  if (path.dirname(credentialFile) !== resolvedBotsDir) throw new Error("credential path escaped bots directory");
  let credentialFd: number | undefined;
  try {
    credentialFd = fs.openSync(credentialFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(credentialFd);
    if (!stat.isFile() || stat.isSymbolicLink() || !isOwnedWithExactMode(stat, 0o600)) {
      throw new Error("credential file security attributes are invalid");
    }
    return JSON.parse(fs.readFileSync(credentialFd, "utf8")) as unknown;
  } finally {
    if (credentialFd !== undefined) {
      try { fs.closeSync(credentialFd); } catch { /* best-effort close */ }
    }
  }
}

export function loadValidatedBotCredential(botsDir: string, appId: string): BotCredentialRecord {
  const value = readSecureBotCredential(botsDir, appId);
  if (!validCredentialRecord(value, appId)) throw new Error("invalid bot credential record");
  return value;
}
