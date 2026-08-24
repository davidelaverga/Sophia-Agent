import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";

import { authBypassEnabled } from "@/app/lib/auth/dev-bypass";
import { voiceLabOrdinaryProductBoundaryResponse } from "@/server/voice-lab/ordinary-route-isolation";

const VOICE_LAB_GOVERNED_BETTER_AUTH_ROUTES = new Set([
	"GET /api/auth/get-session",
	"GET /api/auth/session",
	"POST /api/auth/sign-out",
]);

function governedBetterAuthRequest(request: Request): boolean {
	const pathname = new URL(request.url).pathname;
	return VOICE_LAB_GOVERNED_BETTER_AUTH_ROUTES.has(
		`${request.method.toUpperCase()} ${pathname}`,
	);
}

async function dedicatedPrincipalBoundary(request: Request) {
	if (governedBetterAuthRequest(request)) return null;
	return voiceLabOrdinaryProductBoundaryResponse();
}

function migrationMaintenanceResponse() {
	const enabled = ["1", "true", "yes", "on"].includes(
		(process.env.SOPHIA_MIGRATION_MAINTENANCE_MODE ?? "").trim().toLowerCase(),
	);
	return enabled
		? NextResponse.json(
				{ error: "Authentication is temporarily read-only during a database migration." },
				{ status: 503, headers: { "Retry-After": "60" } },
			)
		: null;
}

export async function GET(request: Request) {
	const maintenance = migrationMaintenanceResponse();
	if (maintenance) {
		return maintenance;
	}
	if (authBypassEnabled) {
		return NextResponse.json({ error: "Auth bypass enabled" }, { status: 404 });
	}
	const boundary = await dedicatedPrincipalBoundary(request);
	if (boundary) return boundary;

	const [{ auth }, { ensureBetterAuthSchema }] = await Promise.all([
		import("@/server/better-auth/config"),
		import("@/server/better-auth/migrations"),
	]);
	const handler = toNextJsHandler(auth.handler);
	await ensureBetterAuthSchema();
	return handler.GET(request);
}

export async function POST(request: Request) {
	const maintenance = migrationMaintenanceResponse();
	if (maintenance) {
		return maintenance;
	}
	if (authBypassEnabled) {
		return NextResponse.json({ error: "Auth bypass enabled" }, { status: 404 });
	}
	const boundary = await dedicatedPrincipalBoundary(request);
	if (boundary) return boundary;

	const [{ auth }, { ensureBetterAuthSchema }] = await Promise.all([
		import("@/server/better-auth/config"),
		import("@/server/better-auth/migrations"),
	]);
	const handler = toNextJsHandler(auth.handler);
	await ensureBetterAuthSchema();
	return handler.POST(request);
}
