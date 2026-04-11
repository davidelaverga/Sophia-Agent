import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";

import { authBypassEnabled } from "@/app/lib/auth/dev-bypass";

export async function GET(request: Request) {
	if (authBypassEnabled) {
		return NextResponse.json({ error: "Auth bypass enabled" }, { status: 404 });
	}

	const [{ auth }, { ensureBetterAuthSchema }] = await Promise.all([
		import("@/server/better-auth/config"),
		import("@/server/better-auth/migrations"),
	]);
	const handler = toNextJsHandler(auth.handler);
	await ensureBetterAuthSchema();
	return handler.GET(request);
}

export async function POST(request: Request) {
	if (authBypassEnabled) {
		return NextResponse.json({ error: "Auth bypass enabled" }, { status: 404 });
	}

	const [{ auth }, { ensureBetterAuthSchema }] = await Promise.all([
		import("@/server/better-auth/config"),
		import("@/server/better-auth/migrations"),
	]);
	const handler = toNextJsHandler(auth.handler);
	await ensureBetterAuthSchema();
	return handler.POST(request);
}
