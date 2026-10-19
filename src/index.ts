import { Container, getContainer } from "@cloudflare/containers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { fetchMeta, fetchTranscript, formatTime, parseLoomId, parseTime, transcriptLines, type LoomMeta, type Transcript } from "./loom";

export class Extractor extends Container {
	defaultPort = 8080;
	sleepAfter = "15m";
	enableInternet = true;
}

interface Env {
	EXTRACTOR: DurableObjectNamespace<Extractor>;
	CACHE: R2Bucket;
	MCP_LIMITER: RateLimit;
	EXTRACT_LIMITER: RateLimit;
}

interface Frame {
	t: number;
	jpeg_base64: string;
}

interface ExtractResult {
	duration: number;
	frames: Frame[];
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Claude Code caps a tool result at 25k tokens by default; leave room for the images.
const MAX_TRANSCRIPT_CHARS = 40_000;

class ToolError extends Error {}

async function cached<T>(env: Env, key: string, produce: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
	const obj = await env.CACHE.get(key);
	if (obj && Date.now() - obj.uploaded.getTime() < CACHE_TTL_MS) {
		return { value: (await obj.json()) as T, hit: true };
	}
	const value = await produce();
	await env.CACHE.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
	return { value, hit: false };
}

async function extract(env: Env, ip: string, id: string, path: string, params: Record<string, string | number>): Promise<ExtractResult> {
	const query = new URLSearchParams({ id, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
	const key = `v1/${id}${path}?${query}`;
	const { value } = await cached(env, key, async () => {
		const { success } = await env.EXTRACT_LIMITER.limit({ key: ip });
		if (!success) throw new ToolError("Rate limit: too many new videos from this IP. Wait a minute and retry.");
		const stub = getContainer(env.EXTRACTOR, id);
		// A container that is still provisioning answers 503; give it a few chances to come up.
		for (let attempt = 0; ; attempt++) {
			const res = await stub.fetch(new Request(`http://extractor${path}?${query}`));
			if (res.status === 503 && attempt < 4) {
				await new Promise((r) => setTimeout(r, 4000));
				continue;
			}
			const body = (await res.json().catch(() => ({ error: `extractor returned HTTP ${res.status}` }))) as ExtractResult & { error?: string };
			if (!res.ok || body.error) throw new ToolError(body.error ?? `extractor returned HTTP ${res.status}`);
			return { duration: body.duration, frames: body.frames };
		}
	});
	return value;
}

async function loadVideo(env: Env, url: string): Promise<{ meta: LoomMeta; transcript: Transcript }> {
	const id = parseLoomId(url);
	if (!id) throw new ToolError("That doesn't look like a Loom link. Expected https://www.loom.com/share/<id>.");
	const [meta, transcript] = await Promise.all([
		cached(env, `v1/${id}/meta`, () => fetchMeta(id)),
		cached(env, `v1/${id}/transcript`, () =>
			fetchTranscript(id).catch((e: Error): Transcript => ({ source: "none", segments: [], error: e.message })),
		),
	]);
	return { meta: meta.value, transcript: transcript.value };
}

function header(meta: LoomMeta, transcript: Transcript, extra: string[]): string {
	const lines = [
		`Loom: ${meta.title}`,
		`URL: ${meta.url}`,
		meta.duration ? `Duration: ${formatTime(meta.duration)}` : null,
		transcript.source === "none"
			? `Transcript: none available${transcript.error ? ` (${transcript.error})` : ""}`
			: `Transcript: ${transcript.segments.length} lines from Loom`,
		meta.description ? `Loom's AI summary: ${meta.description}` : null,
		...extra,
	];
	return lines.filter(Boolean).join("\n");
}

function image(frame: Frame): Content {
	return { type: "image", data: frame.jpeg_base64, mimeType: "image/jpeg" };
}

/** Interleave frames with the transcript spoken while each frame was on screen. */
function timeline(frames: Frame[], transcript: Transcript, from: number, to: number): Content[] {
	const content: Content[] = [];
	let budget = MAX_TRANSCRIPT_CHARS;
	const take = (lines: string[]): string => {
		const out: string[] = [];
		for (const line of lines) {
			if (budget - line.length < 0) {
				out.push("[transcript truncated here; call loom_transcript with start/end for the rest]");
				budget = -1;
				break;
			}
			budget -= line.length;
			out.push(line);
		}
		return out.join("\n");
	};

	const before = budget > 0 ? take(transcriptLines(transcript.segments, from, frames[0]?.t ?? to)) : "";
	if (before) content.push({ type: "text", text: before });
	frames.forEach((frame, i) => {
		const next = frames[i + 1]?.t ?? to;
		content.push({ type: "text", text: `\n▶ Frame ${i + 1}/${frames.length} at [${formatTime(frame.t)}] (on screen until ~${formatTime(next)})` });
		content.push(image(frame));
		const spoken = budget > 0 ? take(transcriptLines(transcript.segments, frame.t, next)) : "";
		if (spoken) content.push({ type: "text", text: spoken });
	});
	return content;
}

function fail(error: unknown) {
	const message = error instanceof ToolError || error instanceof Error ? error.message : String(error);
	return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const urlArg = z.string().describe("Loom share link, e.g. https://www.loom.com/share/8c0df3d006f342c0a4be46169c3ca9b7");
const timeArg = z.union([z.number(), z.string()]).describe('Seconds (102) or a timestamp ("1:42")');
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function createServer(env: Env, ip: string) {
	const server = new McpServer({ name: "loom-context", version: "1.0.0" });

	server.registerTool(
		"loom_overview",
		{
			title: "Watch a Loom video",
			description:
				"Watch a public Loom video: returns its title, Loom's summary, and the full timestamped transcript interleaved with key frames picked wherever the screen changed. Call this first whenever the user shares a loom.com link. The first call on a new video takes ~20-60s while it downloads; repeat calls are cached.",
			inputSchema: z.object({
				url: urlArg,
				frames: z.number().int().min(1).max(16).default(10).describe("Max key frames to return (default 10)"),
			}),
			annotations: READ_ONLY,
		},
		async ({ url, frames }) => {
			try {
				const { meta, transcript } = await loadVideo(env, url);
				const result = await extract(env, ip, meta.id, "/frames", { count: frames, width: 1024 });
				const to = result.duration || meta.duration || Number.MAX_SAFE_INTEGER;
				return {
					content: [
						{
							type: "text" as const,
							text: header(meta, transcript, [
								`Frames: ${result.frames.length} key frames, chosen where the screen meaningfully changed. Transcript lines appear under the frame that was on screen while they were spoken.`,
								"Go deeper: loom_moment(url, start, end) for denser frames of one stretch; loom_frame(url, t) for a single full-resolution frame (small text, code, error messages).",
							]),
						},
						...timeline(result.frames, transcript, 0, to),
					],
				};
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.registerTool(
		"loom_moment",
		{
			title: "Look closely at part of a Loom",
			description:
				"Denser frames plus the transcript for one time range of a Loom video. Use after loom_overview when a specific stretch matters (a bug reproducing, a setting being changed, a quick UI sequence).",
			inputSchema: z.object({
				url: urlArg,
				start: timeArg,
				end: timeArg,
				frames: z.number().int().min(1).max(12).default(6).describe("Max frames within the range (default 6)"),
			}),
			annotations: READ_ONLY,
		},
		async ({ url, start, end, frames }) => {
			try {
				const from = parseTime(start);
				const to = parseTime(end);
				if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new ToolError("start and end must be valid times with end after start");
				const { meta, transcript } = await loadVideo(env, url);
				const result = await extract(env, ip, meta.id, "/frames", { start: from, end: to, count: frames, width: 1280 });
				return {
					content: [
						{ type: "text" as const, text: `${meta.title}: ${formatTime(from)}–${formatTime(to)}, ${result.frames.length} frames` },
						...timeline(result.frames, transcript, from, to),
					],
				};
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.registerTool(
		"loom_frame",
		{
			title: "Grab one Loom frame",
			description: "One full-resolution frame from a Loom video at a timestamp. Use to read small on-screen text, code, or error messages.",
			inputSchema: z.object({
				url: urlArg,
				t: timeArg,
				width: z.number().int().min(320).max(2000).default(1568).describe("Output width in px (default 1568)"),
			}),
			annotations: READ_ONLY,
		},
		async ({ url, t, width }) => {
			try {
				const at = parseTime(t);
				if (!Number.isFinite(at)) throw new ToolError("t must be seconds or a timestamp like 1:42");
				const id = parseLoomId(url);
				if (!id) throw new ToolError("That doesn't look like a Loom link.");
				const result = await extract(env, ip, id, "/frame", { t: Math.round(at * 10) / 10, width });
				return {
					content: [{ type: "text" as const, text: `Frame at [${formatTime(result.frames[0].t)}]` }, image(result.frames[0])],
				};
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.registerTool(
		"loom_transcript",
		{
			title: "Read a Loom transcript",
			description:
				"Transcript only (fast, no frames) for a Loom video or a time range of it. Use when only the words matter, or to read past where loom_overview truncated.",
			inputSchema: z.object({
				url: urlArg,
				start: timeArg.optional(),
				end: timeArg.optional(),
			}),
			annotations: READ_ONLY,
			_meta: { "anthropic/maxResultSizeChars": 200_000 },
		},
		async ({ url, start, end }) => {
			try {
				const { meta, transcript } = await loadVideo(env, url);
				const from = start === undefined ? 0 : parseTime(start);
				const to = end === undefined ? Number.MAX_SAFE_INTEGER : parseTime(end);
				const lines = transcriptLines(transcript.segments, from, to);
				return {
					content: [{ type: "text" as const, text: `${header(meta, transcript, [])}\n\n${lines.join("\n") || "(no transcript lines in this range)"}` }],
				};
			} catch (e) {
				return fail(e);
			}
		},
	);

	return server;
}

const LANDING = `loom-context: a remote MCP server that lets Claude Code watch Loom videos.

Add it to Claude Code:
  claude mcp add --transport http loom https://<this-host>/mcp

Then paste a public loom.com/share link into your conversation.
Tools: loom_overview, loom_moment, loom_frame, loom_transcript.
`;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
			const { success } = await env.MCP_LIMITER.limit({ key: ip });
			if (!success) return new Response("rate limited", { status: 429 });
			return createMcpHandler(() => createServer(env, ip), { route: "/mcp" })(request, env, ctx);
		}
		if (url.pathname === "/") {
			return new Response(LANDING.replace("<this-host>", url.host), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
		}
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
