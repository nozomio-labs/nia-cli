/**
 * Thin REST client for /v2/vaults/* and /v2/fs/{vault_id}/* endpoints used
 * by the bash shell session. Lives separately from the typed SDK because
 * (a) the typed SDK isn't published yet for vaults and (b) the bash session
 * is a hot path that benefits from a small focused client.
 */

export interface VaultLoadResponse {
	vault: Record<string, unknown>;
	namespace: string;
	file_count: number;
	paths_only: boolean;
	files: Array<{
		path: string;
		content?: string;
		language?: string;
		size_bytes?: number;
		mtime?: string;
	}>;
}

export interface VaultReadResponse {
	content: string;
	language?: string;
	metadata?: Record<string, unknown>;
}

export class VaultApiClient {
	constructor(
		private baseUrl: string,
		private apiKey: string,
		private vaultId: string,
	) {}

	private headers(includeJson = false): Record<string, string> {
		const h: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
		};
		if (includeJson) {
			h["Content-Type"] = "application/json";
		}
		return h;
	}

	async load(pathsOnly = false): Promise<VaultLoadResponse> {
		const url = new URL(`${this.baseUrl}/vaults/${this.vaultId}/load`);
		if (pathsOnly) {
			url.searchParams.set("paths_only", "true");
		}
		const r = await fetch(url.toString(), { headers: this.headers() });
		if (!r.ok) {
			throw new Error(`vault load failed: ${r.status} ${await r.text()}`);
		}
		return (await r.json()) as VaultLoadResponse;
	}

	async read(path: string): Promise<VaultReadResponse> {
		const url = new URL(`${this.baseUrl}/fs/${this.vaultId}/read`);
		url.searchParams.set("path", path);
		const r = await fetch(url.toString(), { headers: this.headers() });
		if (!r.ok) {
			throw new Error(`vault read ${path} failed: ${r.status}`);
		}
		return (await r.json()) as VaultReadResponse;
	}

	async write(path: string, body: string): Promise<void> {
		const r = await fetch(`${this.baseUrl}/fs/${this.vaultId}/files`, {
			method: "PUT",
			headers: this.headers(true),
			body: JSON.stringify({ path, body }),
		});
		if (!r.ok) {
			throw new Error(
				`vault write ${path} failed: ${r.status} ${await r.text()}`,
			);
		}
	}

	async deletePath(path: string): Promise<void> {
		const url = new URL(`${this.baseUrl}/fs/${this.vaultId}/files`);
		url.searchParams.set("path", path);
		const r = await fetch(url.toString(), {
			method: "DELETE",
			headers: this.headers(),
		});
		if (!r.ok && r.status !== 404) {
			throw new Error(`vault delete ${path} failed: ${r.status}`);
		}
	}

	async mkdir(path: string): Promise<void> {
		const r = await fetch(`${this.baseUrl}/fs/${this.vaultId}/mkdir`, {
			method: "POST",
			headers: this.headers(true),
			body: JSON.stringify({ path }),
		});
		if (!r.ok) {
			throw new Error(`vault mkdir ${path} failed: ${r.status}`);
		}
	}

	async move(oldPath: string, newPath: string): Promise<void> {
		const r = await fetch(`${this.baseUrl}/fs/${this.vaultId}/mv`, {
			method: "POST",
			headers: this.headers(true),
			body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
		});
		if (!r.ok) {
			throw new Error(`vault mv ${oldPath} -> ${newPath} failed: ${r.status}`);
		}
	}
}
