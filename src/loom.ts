// Loom access. Metadata comes from Loom's public oEmbed endpoint; the transcript comes from
// Loom's internal GraphQL API, which is undocumented and changes, so keep that surface small.

export interface Segment {
	start: number;
	text: string;
}

export interface LoomMeta {
	id: string;
	url: string;
	title: string;
	description: string | null;
	duration: number | null;
}

export interface Transcript {
	source: "loom-json" | "loom-vtt" | "none";
	segments: Segment[];
	error?: string;
}

const UA = "Mozilla/5.0 (compatible; loom-context/1.0)";

export function parseLoomId(input: string): string | null {
	const trimmed = input.trim();
	if (/^[0-9a-f]{32}$/i.test(trimmed)) return trimmed.toLowerCase();
	const match = trimmed.match(/loom\.com\/(?:share|embed|v)\/(?:[^?#]*?)([0-9a-f]{32})/i);
	return match ? match[1].toLowerCase() : null;
}

export async function fetchMeta(id: string): Promise<LoomMeta> {
	const url = `https://www.loom.com/share/${id}`;
	const res = await fetch(`https://www.loom.com/v1/oembed?url=${encodeURIComponent(url)}`, {
		headers: { "User-Agent": UA },
	});
	if (res.status === 404 || res.status === 401 || res.status === 403) {
		throw new Error("Loom says this video doesn't exist or isn't public. Only public share links are supported.");
	}
	if (!res.ok) throw new Error(`Loom oEmbed returned HTTP ${res.status}`);
	const body = (await res.json()) as { title?: string; description?: string; duration?: number };
	return {
		id,
		url,
		title: body.title ?? "Untitled Loom",
		description: body.description?.trim() || null,
		duration: typeof body.duration === "number" ? body.duration : null,
	};
}

const TRANSCRIPT_QUERY =
	"query FetchVideoTranscript($videoId: ID!, $password: String) { fetchVideoTranscript(videoId: $videoId, password: $password) { ... on VideoTranscriptDetails { source_url captions_source_url } ... on GenericError { message } } }";

export async function fetchTranscript(id: string): Promise<Transcript> {
	const res = await fetch("https://www.loom.com/graphql", {
		method: "POST",
		headers: { "Content-Type": "application/json", "apollographql-client-name": "web", "User-Agent": UA },
		body: JSON.stringify({ operationName: "FetchVideoTranscript", variables: { videoId: id, password: null }, query: TRANSCRIPT_QUERY }),
	});
	if (!res.ok) throw new Error(`Loom transcript API returned HTTP ${res.status}`);
	const body = (await res.json()) as {
		data?: { fetchVideoTranscript?: { source_url?: string | null; captions_source_url?: string | null; message?: string } };
		errors?: { message: string }[];
	};
	if (body.errors?.length) throw new Error(`Loom transcript API error: ${body.errors[0].message}`);
	const details = body.data?.fetchVideoTranscript;

	// The JSON transcript is sentence-level; the VTT is split into short caption cues. Prefer JSON.
	if (details?.source_url) {
		const json = (await (await fetch(details.source_url)).json()) as { phrases?: { ts: number; value: string }[] };
		const segments = (json.phrases ?? [])
			.filter((p) => p.value?.trim())
			.map((p) => ({ start: p.ts, text: p.value.trim() }));
		if (segments.length) return { source: "loom-json", segments };
	}
	if (details?.captions_source_url) {
		const segments = parseVtt(await (await fetch(details.captions_source_url)).text());
		if (segments.length) return { source: "loom-vtt", segments };
	}
	return { source: "none", segments: [] };
}

function parseVtt(vtt: string): Segment[] {
	const segments: Segment[] = [];
	for (const block of vtt.split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const timing = lines.findIndex((l) => l.includes("-->"));
		if (timing === -1) continue;
		const start = parseVttTime(lines[timing].split("-->")[0].trim());
		const text = lines
			.slice(timing + 1)
			.join(" ")
			.replace(/<[^>]+>/g, "")
			.trim();
		if (text && start !== null) segments.push({ start, text });
	}
	return segments;
}

function parseVttTime(value: string): number | null {
	const parts = value.split(":").map(Number);
	if (parts.some(Number.isNaN)) return null;
	return parts.reduce((acc, part) => acc * 60 + part, 0);
}

export function formatTime(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Accepts 102, "102", "1:42", "1:02:03", "1m42s". */
export function parseTime(value: number | string): number {
	if (typeof value === "number") return value;
	const v = value.trim();
	if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
	if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(v)) return parseVttTime(v) ?? Number.NaN;
	const hms = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
	if (hms && v) return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0);
	return Number.NaN;
}

export function transcriptLines(segments: Segment[], from: number, to: number): string[] {
	return segments.filter((s) => s.start >= from && s.start < to).map((s) => `[${formatTime(s.start)}] ${s.text}`);
}
