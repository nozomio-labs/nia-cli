/**
 * RemoteVaultFs — `IFileSystem` implementation for just-bash that proxies a
 * remote Nia vault.
 *
 * Strategy: every read first checks an in-memory cache (warmed by the
 * /v2/vaults/{id}/load bootstrap dump). On miss, fall through to the backend
 * via /v2/fs/{id}/read. Every write fires a synchronous backend call before
 * updating the local cache so reads stay coherent. Bash's built-in
 * redirection (`>`, `>>`, `tee`, `cp`, `find -delete`, here-docs, etc.)
 * automatically routes through `writeFile` / `appendFile` / `mkdir` / `rm` /
 * `mv` / `cp`, so we don't need any custom commands.
 *
 * Trade-offs:
 * - Writes are immediate (one HTTP call per write op). For an agent doing
 *   batch writes this is N round trips, but PG `ON CONFLICT` makes it safe
 *   under concurrency and the user never loses work on a session crash.
 * - We don't model real directories — just-bash uses `getAllPaths()` and
 *   path prefix matching to derive directory structure, so our internal
 *   representation is a Set of file paths plus a synthetic stat for dirs.
 */

import { posix as posixPath } from "node:path";
import type {
	BufferEncoding,
	CpOptions,
	FileContent,
	FsStat,
	IFileSystem,
	MkdirOptions,
	RmOptions,
} from "just-bash";
import type { VaultApiClient, VaultLoadResponse } from "./vault-api-client.ts";

// just-bash defines these locally in fs/interface.d.ts but doesn't re-export them.
// Mirror them here so our method signatures structurally satisfy IFileSystem.
interface ReadFileOptions {
	encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
	encoding?: BufferEncoding;
}
interface DirentEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

interface CachedFile {
	content: string;
	mtime: Date;
	size: number;
}

const DEFAULT_FILE_MODE = 0o100644;
const DEFAULT_DIR_MODE = 0o040755;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toText(content: FileContent): string {
	if (typeof content === "string") return content;
	return textDecoder.decode(content);
}

function bytesOf(content: FileContent): number {
	if (typeof content === "string") return textEncoder.encode(content).length;
	return content.byteLength;
}

function normalize(path: string): string {
	if (!path.startsWith("/")) {
		throw new Error(`expected absolute path, got ${path}`);
	}
	const normalized = posixPath.normalize(path);
	// Strip the trailing slash so directory lookups against `dirs` (which stores
	// canonical names without trailing slashes — `path.dirname()` always strips them)
	// match. Root `/` is the one exception.
	return normalized.length > 1 && normalized.endsWith("/")
		? normalized.slice(0, -1)
		: normalized;
}

export class RemoteVaultFs implements IFileSystem {
	private files = new Map<string, CachedFile>();
	private allPaths = new Set<string>();
	private dirs = new Set<string>(["/"]);

	constructor(
		private client: VaultApiClient,
		initial: VaultLoadResponse,
	) {
		for (const f of initial.files) {
			const p = f.path.startsWith("/") ? f.path : `/${f.path}`;
			this.allPaths.add(p);
			this.indexParents(p);
			if (f.content !== undefined) {
				this.files.set(p, {
					content: f.content,
					mtime: f.mtime ? new Date(f.mtime) : new Date(),
					size: f.size_bytes ?? bytesOf(f.content),
				});
			}
		}
	}

	private indexParents(path: string): void {
		let dir = posixPath.dirname(path);
		while (dir && dir !== "/") {
			this.dirs.add(dir);
			dir = posixPath.dirname(dir);
		}
		this.dirs.add("/");
	}

	private async fetchFile(path: string): Promise<CachedFile | null> {
		try {
			const r = await this.client.read(path);
			const cached: CachedFile = {
				content: r.content,
				mtime: new Date(),
				size: bytesOf(r.content),
			};
			this.files.set(path, cached);
			this.allPaths.add(path);
			this.indexParents(path);
			return cached;
		} catch {
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Read
	// -----------------------------------------------------------------------

	async readFile(
		path: string,
		_options?: ReadFileOptions | BufferEncoding,
	): Promise<string> {
		const p = normalize(path);
		const cached = this.files.get(p);
		if (cached) return cached.content;
		if (this.dirs.has(p)) {
			throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
		}
		const fetched = await this.fetchFile(p);
		if (!fetched) {
			throw new Error(`ENOENT: no such file or directory, open '${p}'`);
		}
		return fetched.content;
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const text = await this.readFile(path);
		return textEncoder.encode(text);
	}

	async exists(path: string): Promise<boolean> {
		const p = normalize(path);
		if (this.allPaths.has(p) || this.dirs.has(p)) return true;
		const fetched = await this.fetchFile(p);
		return fetched !== null;
	}

	async stat(path: string): Promise<FsStat> {
		const p = normalize(path);
		if (this.dirs.has(p)) {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DEFAULT_DIR_MODE,
				size: 0,
				mtime: new Date(),
			};
		}
		const cached = this.files.get(p);
		if (cached) {
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: DEFAULT_FILE_MODE,
				size: cached.size,
				mtime: cached.mtime,
			};
		}
		if (this.allPaths.has(p)) {
			// We know the path exists from the load dump but the body wasn't included
			// (paths_only mode). Fetch on demand for stat.
			const fetched = await this.fetchFile(p);
			if (fetched) {
				return {
					isFile: true,
					isDirectory: false,
					isSymbolicLink: false,
					mode: DEFAULT_FILE_MODE,
					size: fetched.size,
					mtime: fetched.mtime,
				};
			}
		}
		throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
	}

	async lstat(path: string): Promise<FsStat> {
		return this.stat(path);
	}

	async readdir(path: string): Promise<string[]> {
		const p = normalize(path);
		if (!this.dirs.has(p) && p !== "/") {
			throw new Error(`ENOTDIR: not a directory, readdir '${p}'`);
		}
		const prefix = p === "/" ? "/" : `${p}/`;
		const entries = new Set<string>();
		for (const fp of this.allPaths) {
			if (!fp.startsWith(prefix)) continue;
			const rest = fp.slice(prefix.length);
			if (!rest) continue;
			const head = rest.split("/")[0] ?? "";
			if (head) entries.add(head);
		}
		// Also include sub-dirs that were registered explicitly via mkdir.
		for (const d of this.dirs) {
			if (!d.startsWith(prefix) || d === p) continue;
			const rest = d.slice(prefix.length);
			if (!rest) continue;
			const head = rest.split("/")[0] ?? "";
			if (head) entries.add(head);
		}
		return [...entries].sort();
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const p = normalize(path);
		const names = await this.readdir(p);
		const prefix = p === "/" ? "/" : `${p}/`;
		const out: DirentEntry[] = [];
		for (const name of names) {
			const child = `${prefix}${name}`;
			const isFile = this.allPaths.has(child);
			const isDirectory =
				this.dirs.has(child) || (!isFile && this.hasChildren(child));
			out.push({
				name,
				isFile,
				isDirectory,
				isSymbolicLink: false,
			});
		}
		return out;
	}

	private hasChildren(path: string): boolean {
		const prefix = `${path}/`;
		for (const fp of this.allPaths) {
			if (fp.startsWith(prefix)) return true;
		}
		return false;
	}

	getAllPaths(): string[] {
		return [...this.allPaths];
	}

	resolvePath(base: string, path: string): string {
		if (path.startsWith("/")) return posixPath.normalize(path);
		return posixPath.normalize(posixPath.join(base, path));
	}

	async realpath(path: string): Promise<string> {
		return normalize(path);
	}

	async readlink(_path: string): Promise<string> {
		throw new Error("symlinks not supported on vault filesystems");
	}

	// -----------------------------------------------------------------------
	// Write — proxied to backend immediately
	// -----------------------------------------------------------------------

	async writeFile(
		path: string,
		content: FileContent,
		_options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		const p = normalize(path);
		const text = toText(content);
		await this.client.write(p, text);
		this.files.set(p, {
			content: text,
			mtime: new Date(),
			size: bytesOf(text),
		});
		this.allPaths.add(p);
		this.indexParents(p);
	}

	async appendFile(
		path: string,
		content: FileContent,
		_options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		const p = normalize(path);
		const text = toText(content);
		let existing = "";
		try {
			existing = await this.readFile(p);
		} catch {
			existing = "";
		}
		const next = existing + text;
		await this.client.write(p, next);
		this.files.set(p, {
			content: next,
			mtime: new Date(),
			size: bytesOf(next),
		});
		this.allPaths.add(p);
		this.indexParents(p);
	}

	async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
		const p = normalize(path);
		await this.client.mkdir(p);
		this.dirs.add(p);
		this.indexParents(p);
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		const p = normalize(path);
		const recursive = options?.recursive ?? false;
		const force = options?.force ?? false;

		if (this.dirs.has(p) && p !== "/") {
			if (!recursive) {
				const children = await this.readdir(p);
				if (children.length > 0) {
					throw new Error(`ENOTEMPTY: directory not empty, rmdir '${p}'`);
				}
			}
			// Recursively delete every file under this dir.
			const prefix = `${p}/`;
			const toDelete = [...this.allPaths].filter((fp) => fp.startsWith(prefix));
			for (const fp of toDelete) {
				try {
					await this.client.deletePath(fp);
				} catch (err) {
					if (!force) throw err;
				}
				this.files.delete(fp);
				this.allPaths.delete(fp);
			}
			this.dirs.delete(p);
			return;
		}

		if (!this.allPaths.has(p) && !this.files.has(p)) {
			if (force) return;
			throw new Error(`ENOENT: no such file or directory, rm '${p}'`);
		}
		try {
			await this.client.deletePath(p);
		} catch (err) {
			if (!force) throw err;
		}
		this.files.delete(p);
		this.allPaths.delete(p);
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		const srcPath = normalize(src);
		const destPath = normalize(dest);
		const recursive = options?.recursive ?? false;

		if (this.dirs.has(srcPath)) {
			if (!recursive) {
				throw new Error(`EISDIR: ${srcPath} is a directory, cp without -r`);
			}
			const prefix = `${srcPath}/`;
			for (const fp of this.allPaths) {
				if (!fp.startsWith(prefix)) continue;
				const sub = fp.slice(prefix.length);
				const newPath = `${destPath}/${sub}`;
				const content = await this.readFile(fp);
				await this.writeFile(newPath, content);
			}
			return;
		}

		const content = await this.readFile(srcPath);
		await this.writeFile(destPath, content);
	}

	async mv(src: string, dest: string): Promise<void> {
		const srcPath = normalize(src);
		const destPath = normalize(dest);
		await this.client.move(srcPath, destPath);

		// Update local cache: handle both file and directory moves.
		if (this.dirs.has(srcPath)) {
			const prefix = `${srcPath}/`;
			const moved: Array<{ from: string; to: string }> = [];
			for (const fp of this.allPaths) {
				if (fp.startsWith(prefix)) {
					moved.push({
						from: fp,
						to: `${destPath}/${fp.slice(prefix.length)}`,
					});
				}
			}
			for (const m of moved) {
				const cached = this.files.get(m.from);
				this.files.delete(m.from);
				this.allPaths.delete(m.from);
				if (cached) this.files.set(m.to, cached);
				this.allPaths.add(m.to);
				this.indexParents(m.to);
			}
			this.dirs.delete(srcPath);
			this.dirs.add(destPath);
			return;
		}

		const cached = this.files.get(srcPath);
		this.files.delete(srcPath);
		this.allPaths.delete(srcPath);
		if (cached) this.files.set(destPath, cached);
		this.allPaths.add(destPath);
		this.indexParents(destPath);
	}

	async chmod(_path: string, _mode: number): Promise<void> {
		// no-op: vaults do not model permissions
	}

	async symlink(_target: string, _linkPath: string): Promise<void> {
		throw new Error("symlinks not supported on vault filesystems");
	}

	async link(_existing: string, _newPath: string): Promise<void> {
		throw new Error("hard links not supported on vault filesystems");
	}

	async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
		// no-op: mtime is server-controlled
	}
}
