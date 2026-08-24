import { constants as fsConstants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MAX_JSON_BYTES = 2_000_000;

export async function assertUnusedAbsolutePaths(paths: readonly string[]): Promise<void> {
  if (paths.length === 0 || new Set(paths).size !== paths.length) throw new Error("Output paths must be non-empty and distinct.");
  for (const target of paths) {
    assertAbsolute(target);
    const parent = await lstat(path.dirname(target));
    if (!parent.isDirectory()) throw new Error(`Output parent is not a directory: ${path.dirname(target)}`);
    try {
      await lstat(target);
      throw new Error(`Refusing to overwrite existing output: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Publish a new file without an overwrite race. A mode-0600 temporary inode is
 * fsynced and hard-linked into its final name; link(2) fails if the target
 * already exists. Files are always created in the target directory, so this
 * remains atomic on one filesystem and never follows a target symlink.
 */
export async function writeNewSecureFile(target: string, bytes: Uint8Array): Promise<void> {
  assertAbsolute(target);
  const directory = path.dirname(target);
  const parent = await lstat(directory);
  if (!parent.isDirectory()) throw new Error(`Output parent is not a directory: ${directory}`);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, target);
    await unlink(temporary);
    temporaryExists = false;
    await fsyncDirectory(directory);
    await assertSecureRegularFile(target);
  } catch (error) {
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Refusing to overwrite existing output: ${target}`);
    throw error;
  }
}

export async function writeNewSecureJson(target: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await writeNewSecureFile(target, bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function readSecureFile(target: string, maximumBytes = MAX_JSON_BYTES): Promise<Buffer> {
  assertAbsolute(target);
  const handle = await open(target, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Secure input is not a regular file: ${target}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Secure input must have mode 0600 (or stricter): ${target}`);
    if (stat.size < 1 || stat.size > maximumBytes) throw new Error(`Secure input is outside its byte limit: ${target}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readSecureJson(target: string): Promise<unknown> {
  const bytes = await readSecureFile(target);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`Secure JSON input is invalid: ${target}`);
  } finally {
    bytes.fill(0);
  }
}

export async function readPublicJson(target: string): Promise<unknown> {
  const bytes = await readPublicFile(target);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error(`Public JSON input is invalid: ${target}`); }
}

export async function readPublicFile(target: string): Promise<Buffer> {
  assertAbsolute(target);
  const handle = await open(target, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_JSON_BYTES) throw new Error(`Public JSON input is outside its file contract: ${target}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function assertSecureRegularFile(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular non-symlink file: ${target}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`File permissions are broader than 0600: ${target}`);
}

function assertAbsolute(target: string): void {
  if (!path.isAbsolute(target) || path.normalize(target) !== target) throw new Error(`File path must be absolute and normalized: ${target}`);
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); }
  catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { await handle.close(); }
}
