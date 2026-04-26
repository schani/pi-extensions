import { tmpdir } from "node:os";
import { join } from "node:path";

export function getCompanionSocketPath() {
	if (process.platform === "win32") {
		return "\\\\.\\pipe\\pi-companion-mood";
	}
	return join(tmpdir(), "pi-companion-mood.sock");
}

export function usesNamedPipe(socketPath) {
	return socketPath.startsWith("\\\\.\\pipe\\");
}
