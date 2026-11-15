/** Shared fetch helpers for the ported automation settings panels. */

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const json = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
	if (!response.ok) throw new Error(json?.error ?? `Request failed (${response.status})`);
	return json as T;
}

export const apiGet = <T>(path: string) => request<T>("GET", path);
export const apiPost = <T>(path: string, body: unknown) => request<T>("POST", path, body);
export const apiPatch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
export const apiDelete = <T>(path: string) => request<T>("DELETE", path);