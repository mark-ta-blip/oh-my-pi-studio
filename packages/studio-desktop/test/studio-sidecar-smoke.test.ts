import { afterEach, expect, test } from "bun:test";
import { verifyStudioSidecarAccess } from "../src/main/studio-server";

const servers: Bun.Server[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function startSidecarFixture(bootstrap: (request: Request) => Response): string {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/" && url.searchParams.get("token") === "fixture-access-token") {
				return new Response(null, {
					status: 302,
					headers: {
						Location: "/",
						"Set-Cookie": "omp_studio_session=fixture-session; Path=/; HttpOnly; SameSite=Strict",
					},
				});
			}
			if (url.pathname === "/api/v1/bootstrap") return bootstrap(request);
			return new Response("Not Found", { status: 404 });
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}/?token=fixture-access-token`;
}

test("exchanges the one-time sidecar URL before reading the authenticated bootstrap", async () => {
	let bootstrapCookie: string | null = null;
	const url = startSidecarFixture(request => {
		bootstrapCookie = request.headers.get("cookie");
		if (bootstrapCookie !== "omp_studio_session=fixture-session") {
			return new Response("Local access required", { status: 401 });
		}
		return Response.json({ apiVersion: 1, mode: "local-single-user" });
	});

	await verifyStudioSidecarAccess(url);

	expect(bootstrapCookie).toBe("omp_studio_session=fixture-session");
});

test("rejects a sidecar whose authenticated bootstrap is not the Studio local contract", async () => {
	const url = startSidecarFixture(request => {
		if (request.headers.get("cookie") !== "omp_studio_session=fixture-session") {
			return new Response("Local access required", { status: 401 });
		}
		return Response.json({ apiVersion: 99, mode: "remote" });
	});

	await expect(verifyStudioSidecarAccess(url)).rejects.toThrow(
		"OMP Studio sidecar bootstrap did not match the local Studio contract.",
	);
});
