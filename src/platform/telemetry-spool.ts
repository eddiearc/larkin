import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { TelemetryConfig } from "./telemetry-config.js";

export interface OtlpPayload { resourceSpans: unknown[] }
export interface QueueStatus {
  queuedFiles: number; queuedBytes: number; oldestAgeMs: number | null;
  droppedFiles: number; lastUploadAt: string | null; lastErrorCategory: string | null;
}
interface Diagnostics { droppedFiles: number; lastUploadAt: string | null; lastErrorCategory: string | null }
interface BundleRecord { sha256: string; payload: OtlpPayload }
interface TelemetryBundle { format: "larkin-otlp-bundle"; version: 1; createdAt: string; records: BundleRecord[] }

const READY = /^(?:span-[0-9a-f-]+|import-[0-9a-f]{64})\.json$/;
const emptyDiagnostics = (): Diagnostics => ({ droppedFiles: 0, lastUploadAt: null, lastErrorCategory: null });

export class TelemetrySpool {
  constructor(readonly config: Pick<TelemetryConfig, "spoolDir" | "maxBytes" | "maxFiles" | "maxAgeMs">) {}

  private ensure(): void {
    const parent = path.dirname(this.config.spoolDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { if (fs.lstatSync(this.config.spoolDir).isSymbolicLink()) throw new Error("telemetry spool must not be a symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fs.mkdirSync(this.config.spoolDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.config.spoolDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("telemetry spool is not a secure directory");
    fs.chmodSync(this.config.spoolDir, 0o700);
  }

  private readyFiles(): Array<{ file: string; size: number; mtimeMs: number }> {
    this.ensure();
    return fs.readdirSync(this.config.spoolDir).filter((name) => READY.test(name)).flatMap((name) => {
      const file = path.join(this.config.spoolDir, name);
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ file, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
    }).sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  }

  private atomicWrite(file: string, bytes: Buffer): void {
    this.ensure();
    const temporary = path.join(this.config.spoolDir, `.write-${process.pid}-${crypto.randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
      const directory = fs.openSync(this.config.spoolDir, fs.constants.O_RDONLY); fs.fsyncSync(directory); fs.closeSync(directory);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  enqueue(payload: OtlpPayload): string {
    if (!payload || !Array.isArray(payload.resourceSpans)) throw new Error("invalid OTLP trace payload");
    const file = path.join(this.config.spoolDir, `span-${crypto.randomUUID()}.json`);
    this.atomicWrite(file, Buffer.from(JSON.stringify(payload)));
    this.prune();
    return file;
  }

  list(limit = Number.MAX_SAFE_INTEGER): Array<{ file: string; payload: OtlpPayload }> {
    return this.readyFiles().slice(0, limit).map(({ file }) => ({ file, payload: JSON.parse(fs.readFileSync(file, "utf8")) as OtlpPayload }));
  }

  acknowledge(files: readonly string[]): void {
    const root = `${path.resolve(this.config.spoolDir)}${path.sep}`;
    for (const file of files) {
      const resolved = path.resolve(file);
      if (!resolved.startsWith(root) || !READY.test(path.basename(resolved))) throw new Error("invalid telemetry acknowledgement path");
      try { fs.unlinkSync(resolved); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private diagnostics(): Diagnostics {
    try { return { ...emptyDiagnostics(), ...JSON.parse(fs.readFileSync(path.join(this.config.spoolDir, "diagnostics.json"), "utf8")) }; }
    catch { return emptyDiagnostics(); }
  }

  updateDiagnostics(patch: Partial<Diagnostics>): void {
    this.atomicWrite(path.join(this.config.spoolDir, "diagnostics.json"), Buffer.from(JSON.stringify({ ...this.diagnostics(), ...patch })));
  }

  prune(now = Date.now()): void {
    let files = this.readyFiles();
    let dropped = 0;
    for (const entry of files.filter((entry) => now - entry.mtimeMs > this.config.maxAgeMs)) {
      fs.unlinkSync(entry.file); dropped += 1;
    }
    files = this.readyFiles();
    let bytes = files.reduce((sum, entry) => sum + entry.size, 0);
    while (files.length > this.config.maxFiles || bytes > this.config.maxBytes) {
      const oldest = files.shift(); if (!oldest) break;
      fs.unlinkSync(oldest.file); bytes -= oldest.size; dropped += 1;
    }
    if (dropped) this.updateDiagnostics({ droppedFiles: this.diagnostics().droppedFiles + dropped });
  }

  status(now = Date.now()): QueueStatus {
    const files = this.readyFiles();
    const diagnostic = this.diagnostics();
    return { queuedFiles: files.length, queuedBytes: files.reduce((sum, item) => sum + item.size, 0),
      oldestAgeMs: files[0] ? Math.max(0, now - files[0].mtimeMs) : null, ...diagnostic };
  }

  exportBundle(destination: string): { records: number; sha256: string } {
    const records = this.list().map(({ payload }) => {
      const bytes = Buffer.from(JSON.stringify(payload));
      return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), payload };
    });
    const bundle: TelemetryBundle = { format: "larkin-otlp-bundle", version: 1, createdAt: new Date().toISOString(), records };
    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
    fs.writeFileSync(destination, compressed, { mode: 0o600, flag: "wx" });
    return { records: records.length, sha256: crypto.createHash("sha256").update(compressed).digest("hex") };
  }

  importBundle(source: string, maxBundleBytes = 128 * 1024 * 1024): { imported: number; duplicates: number } {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBundleBytes) throw new Error("telemetry bundle is invalid or too large");
    const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(source), { maxOutputLength: maxBundleBytes }).toString("utf8")) as TelemetryBundle;
    if (parsed.format !== "larkin-otlp-bundle" || parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error("unsupported telemetry bundle");
    let imported = 0; let duplicates = 0;
    for (const record of parsed.records) {
      const bytes = Buffer.from(JSON.stringify(record.payload));
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== record.sha256 || !Array.isArray(record.payload?.resourceSpans)) throw new Error("telemetry bundle checksum failed");
      const destination = path.join(this.config.spoolDir, `import-${sha256}.json`);
      if (fs.existsSync(destination)) { duplicates += 1; continue; }
      this.atomicWrite(destination, bytes); imported += 1;
    }
    this.prune();
    return { imported, duplicates };
  }
}
